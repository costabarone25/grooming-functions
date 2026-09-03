const sdk = require('node-appwrite');
const admin = require('firebase-admin');

const client = new sdk.Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new sdk.Databases(client);
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function getUserToken(userId) {
    try {
        const res = await databases.listDocuments(
            process.env.DATABASE_ID,
            process.env.USERS_TABLE_ID,
            [sdk.Query.equal('userId', userId)]
        );
        if (res.documents.length > 0) {
            return res.documents[0].data.deviceToken || null;
        }
    } catch (e) { console.error(e); }
    return null;
}

async function sendFCM(token, title, body, data = {}) {
    if (!token) return;
    try {
        await admin.messaging().send({
            token,
            notification: { title, body },
            data,
        });
        console.log(`✅ Уведомление отправлено: ${title}`);
    } catch (e) {
        console.error('❌ Ошибка FCM:', e);
    }
}

async function getSalonOwner(salonId) {
    if (!salonId) return null;
    try {
        const res = await databases.listDocuments(
            process.env.DATABASE_ID,
            process.env.USERS_TABLE_ID,
            [
                sdk.Query.equal('salonId', salonId),
                sdk.Query.equal('role', 'salon')
            ]
        );
        if (res.documents.length > 0) return res.documents[0].data.userId;
    } catch (e) { console.error(e); }
    return null;
}

module.exports = async (req, res) => {
    // ========== ЗАЩИТА ОТ РУЧНОГО ЗАПУСКА ==========
    const event = req.headers && req.headers['x-appwrite-event'] 
        ? req.headers['x-appwrite-event'] 
        : (req.body && req.body.event ? req.body.event : null);
    
    if (!event) {
        console.log('ℹ️ Ручной запуск или тестовый вызов. Пропускаем.');
        return res.json({ message: 'Manual execution, no event processed.' });
    }
    // ================================================

    const payload = req.body.payload || {};
    const doc = payload.document || {};
    const data = doc.data || {};

    try {
        if (event.includes('appointments')) {
            const appointmentId = doc.$id;
            const userId = data.userId;
            const groomerId = data.groomerId;
            const salonId = data.salonId;
            const details = data.details || '';

            if (event.includes('create')) {
                if (groomerId) {
                    const token = await getUserToken(groomerId);
                    await sendFCM(token, 'Новая запись', `Владелец создал запись: ${details}`, { appointmentId });
                }
                if (salonId) {
                    const salonOwner = await getSalonOwner(salonId);
                    if (salonOwner) {
                        const token = await getUserToken(salonOwner);
                        await sendFCM(token, 'Новая запись в салоне', `Клиент записался: ${details}`, { appointmentId });
                    }
                }
            }

            if (event.includes('update')) {
                const oldData = payload.oldDocument?.data || {};
                const oldStatus = oldData.status || 'pending';
                const newStatus = data.status || 'pending';

                if (oldStatus !== 'approved' && newStatus === 'approved') {
                    const token = await getUserToken(userId);
                    await sendFCM(token, 'Запись одобрена', `Ваша запись ${details} подтверждена!`, { appointmentId });
                }
                if (oldStatus !== 'cancelled' && newStatus === 'cancelled') {
                    const recipients = [userId, groomerId, await getSalonOwner(salonId)].filter(Boolean);
                    for (const uid of recipients) {
                        const token = await getUserToken(uid);
                        await sendFCM(token, 'Запись отменена', `Запись ${details} была отменена.`, { appointmentId });
                    }
                }
            }

            if (event.includes('delete')) {
                const deletedData = payload.document?.data || {};
                const recipients = [deletedData.userId, deletedData.groomerId, await getSalonOwner(deletedData.salonId)].filter(Boolean);
                for (const uid of recipients) {
                    const token = await getUserToken(uid);
                    await sendFCM(token, 'Запись удалена', `Запись ${deletedData.details || ''} была удалена.`, {});
                }
            }
        }

        if (event.includes('join_requests')) {
            const requestId = doc.$id;
            const userId = data.userId;
            const salonId = data.salonId;
            const status = data.status;

            if (event.includes('create')) {
                const salonOwner = await getSalonOwner(salonId);
                if (salonOwner) {
                    const token = await getUserToken(salonOwner);
                    await sendFCM(token, 'Новая заявка в штат', 'Пользователь хочет присоединиться к вашему салону.', { requestId });
                }
            }
            if (event.includes('update')) {
                const oldStatus = payload.oldDocument?.data?.status || '';
                if (oldStatus !== 'approved' && status === 'approved') {
                    const token = await getUserToken(userId);
                    await sendFCM(token, 'Заявка одобрена', 'Ваша заявка на вступление в салон одобрена!', { requestId });
                }
                if (oldStatus !== 'rejected' && status === 'rejected') {
                    const token = await getUserToken(userId);
                    await sendFCM(token, 'Заявка отклонена', 'Ваша заявка на вступление в салон отклонена.', { requestId });
                }
            }
        }

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ error: e.message });
    }
};
