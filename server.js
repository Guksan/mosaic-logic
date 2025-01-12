const express = require('express');
const multer = require('multer');
const stripe = require('stripe');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Načtení konfigurace
dotenv.config();

// Inicializace aplikace
const app = express();
const upload = multer();
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// AWS S3 Konfigurace
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Inicializace SQLite databáze
const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Chyba při připojení k SQLite:', err.message);
    } else {
        console.log('Připojeno k SQLite databázi');
    }
});

// Vytvoření tabulky objednávek
const createTableQuery = `
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    package TEXT NOT NULL,
    files TEXT NOT NULL,
    paymentStatus TEXT DEFAULT 'Pending',
    orderDate TEXT DEFAULT CURRENT_TIMESTAMP
);
`;
db.run(createTableQuery, (err) => {
    if (err) {
        console.error('Chyba při vytváření tabulky:', err.message);
    } else {
        console.log('Tabulka objednávek byla vytvořena nebo již existuje');
    }
});

// Endpoint pro vytvoření objednávky
app.post('/api/orders/create', upload.array('photos'), async (req, res) => {
    const { email, package } = req.body;
    const files = req.files;
    const photoUrls = [];

    try {
        // Nahrajte fotografie na S3
        for (const file of files) {
            const params = {
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: `${Date.now()}-${file.originalname}`,
                Body: file.buffer,
            };
            const command = new PutObjectCommand(params);
            await s3.send(command);
            photoUrls.push(`https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`);
        }

        // Uložení objednávky do SQLite databáze
        const insertQuery = `
        INSERT INTO orders (email, package, files, paymentStatus)
        VALUES (?, ?, ?, ?)
        `;
        db.run(insertQuery, [email, package, JSON.stringify(photoUrls), 'Awaiting Payment'], function (err) {
            if (err) {
                console.error('Chyba při ukládání do SQLite:', err.message);
                return res.status(500).json({ error: 'Chyba při ukládání objednávky.' });
            }

            const orderId = this.lastID;

            // Stripe Checkout Session
            let priceId;
            if (package === 'Základní balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
            if (package === 'Pokročilý balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
            if (package === 'Prémiový balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';

            stripeClient.checkout.sessions
                .create({
                    payment_method_types: ['card'],
                    customer_email: email,
                    line_items: [{ price: priceId, quantity: 1 }],
                    mode: 'payment',
                    success_url: `https://your-domain.com/success?orderId=${orderId}`,
                    cancel_url: 'https://your-domain.com/cancel',
                })
                .then((session) => {
                    res.status(200).json({ url: session.url });
                })
                .catch((error) => {
                    console.error('Chyba při vytváření Stripe session:', error);
                    res.status(500).json({ error: 'Chyba při vytváření platby.' });
                });
        });
    } catch (error) {
        console.error('Chyba:', error);
        res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
    }
});

// Endpoint pro seznam objednávek
app.get('/api/orders', (req, res) => {
    const selectQuery = `SELECT * FROM orders ORDER BY orderDate DESC`;
    db.all(selectQuery, [], (err, rows) => {
        if (err) {
            console.error('Chyba při načítání objednávek:', err.message);
            return res.status(500).json({ error: 'Chyba při načítání objednávek.' });
        }
        res.json(rows);
    });
});

// Spuštění serveru
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
