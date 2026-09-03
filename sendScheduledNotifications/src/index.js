const sdk = require('node-appwrite');
const admin = require('firebase-admin');

const client = new sdk.Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new sdk.Databases(client);
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function sendFCM(token, title, body, data = {}) {
    if (!token) return;
    try {
        await admin.messaging().send({ token, notification: { title, body }, data });
        console.log(`✅ Напоминание отправлено: ${title}`);
    } catch (e) {
        console.error('❌ Ошибка FCM:', e);
    }
}

async function getUserToken(userId) {
    try {
        const res = await databases.listDocuments(
            process.env.DATABASE_ID,
            process.env.USERS_TABLE_ID,
            [sdk.Query.equal('userId', userId)]
        );
        if (res.documents.length > 0) return res.documents[0].data.deviceToken || null;
    } catch (e) {
        console.error(e);
    }
    return null;
}

module.exports = async (req, res) => {
    try {
        const now = new Date();
        const nowISO = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        const appts = await databases.listDocuments(
            process.env.DATABASE_ID,
            process.env.APPOINTMENTS_TABLE_ID,
            [
                sdk.Query.equal('date', nowISO),
                sdk.Query.notEqual('status', 'cancelled')
            ]
        );

        console.log(`📅 Найдено записей на сегодня: ${appts.documents.length}`);

        for (const doc of appts.documents) {
            const data = doc.data;
            const startTime = data.startTime; // "HH:MM"
            const [h, m] = startTime.split(':').map(Number);
            const startMinutes = h * 60 + m;

            // За 30 минут
            const diff30 = startMinutes - nowMinutes;
            if (diff30 > 0 && diff30 <= 30 && !data.notified_30min) {
                const groomerId = data.groomerId;
                const ownerId = data.userId;
                const tokens = [];
                if (groomerId) {
                    const t = await getUserToken(groomerId);
                    if (t) tokens.push(t);
                }
                if (ownerId) {
                    const t = await getUserToken(ownerId);
                    if (t) tokens.push(t);
                }
                for (const token of tokens) {
                    await sendFCM(token, 'Скоро запись!', `Через 30 минут начнётся запись ${data.details || ''}`, { appointmentId: doc.$id });
                }
                await databases.updateDocument(
                    process.env.DATABASE_ID,
                    process.env.APPOINTMENTS_TABLE_ID,
                    doc.$id,
                    { notified_30min: true }
                );
                console.log(`⏰ Напоминание за 30 минут отправлено для записи ${doc.$id}`);
            }

            // За 24 часа
            const diff24 = startMinutes - nowMinutes + 24 * 60;
            if (diff24 > 0 && diff24 <= 24*60 && !data.notified_24h) {
                const ownerId = data.userId;
                if (ownerId) {
                    const token = await getUserToken(ownerId);
                    if (token) {
                        await sendFCM(token, 'Напоминание о записи', `Завтра в ${startTime} запись ${data.details || ''}`, { appointmentId: doc.$id });
                    }
                }
                await databases.updateDocument(
                    process.env.DATABASE_ID,
                    process.env.APPOINTMENTS_TABLE_ID,
                    doc.$id,
                    { notified_24h: true }
                );
                console.log(`📆 Напоминание за 24 часа отправлено для записи ${doc.$id}`);
            }
        }

        // === ЗАЩИТА ОТ ОТСУТСТВИЯ res ===
        if (res && typeof res.json === 'function') {
            res.json({ success: true });
        } else {
            console.log('ℹ️ Функция завершена (ответ не отправлен, так как res недоступен)');
        }
    } catch (e) {
        console.error('❌ Ошибка в функции:', e);
        if (res && typeof res.json === 'function') {
            res.json({ error: e.message });
        }
    }
};
