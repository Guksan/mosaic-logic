const express = require('express');
const multer = require('multer');
const stripe = require('stripe');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors'); // Importujeme CORS

// Načtení konfigurace
dotenv.config();

// Inicializace aplikace
const app = express();
app.use(cors()); // Povolujeme CORS pro všechny původy
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
    console.log('Přijatý požadavek na /api/orders/create');
    console.log('Tělo požadavku:', req.body);
    console.log('Přiložené soubory:', req.files);

    const { email, package } = req.body;
    const files = req.files;
    const photoUrls = [];

    try {
        // Kontrola, zda již existuje objednávka se stejným e-mailem
        const selectQuery = `SELECT * FROM orders WHERE email = ? AND paymentStatus = 'Pending'`;
        db.get(selectQuery, [email], (err, row) => {
            if (err) {
                console.error('Chyba při kontrole existující objednávky:', err.message);
                return res.status(500).json({ error: 'Chyba při kontrole existující objednávky.' });
            }

            if (row) {
                console.log('Objednávka se stejným e-mailem již existuje:', row);
                return res.status(400).json({ error: 'Objednávka s tímto e-mailem již existuje. Dokončete platbu před vytvořením nové objednávky.' });
            }

            // Uložení objednávky do SQLite databáze
            console.log('Ukládám objednávku do databáze...');
            const insertQuery = `
            INSERT INTO orders (email, package, files, paymentStatus)
            VALUES (?, ?, ?, ?)
            `;
            db.run(insertQuery, [email, package, JSON.stringify([]), 'Awaiting Payment'], function (err) {
                if (err) {
                    console.error('Chyba při ukládání do SQLite:', err.message);
                    return res.status(500).json({ error: 'Chyba při ukládání objednávky.' });
                }

                const orderId = this.lastID;
                console.log(`Objednávka uložena s ID: ${orderId}`);

                // Vytvoření složky na S3 podle ID objednávky
                const folderKey = `orders/${orderId}/`;

                // Nahrajte fotografie na S3
                const uploadPromises = files.map(async (file, index) => {
                    console.log(`Nahrávám soubor: ${file.originalname}`);
                    const fileKey = `${folderKey}${Date.now()}-${index}-${file.originalname}`;
                    const params = {
                        Bucket: process.env.AWS_BUCKET_NAME,
                        Key: fileKey,
                        Body: file.buffer,
                    };
                    const command = new PutObjectCommand(params);
                    await s3.send(command);
                    const fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;
                    photoUrls.push(fileUrl);
                    console.log(`Soubor nahrán na: ${fileUrl}`);
                });

                Promise.all(uploadPromises)
                    .then(() => {
                        // Aktualizace databáze s URL nahraných souborů
                        const updateQuery = `UPDATE orders SET files = ? WHERE id = ?`;
                        db.run(updateQuery, [JSON.stringify(photoUrls), orderId], (err) => {
                            if (err) {
                                console.error('Chyba při aktualizaci objednávky v SQLite:', err.message);
                                return res.status(500).json({ error: 'Chyba při aktualizaci objednávky.' });
                            }

                            console.log('Objednávka aktualizována s URL souborů');

                            // Stripe Checkout Session
                            let priceId;
                            if (package === 'Základní balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
                            if (package === 'Pokročilý balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
                            if (package === 'Prémiový balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';

                            console.log('Vytvářím Stripe Checkout Session...');
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
                                    console.log('Stripe Checkout Session vytvořena:', session.url);
                                    res.status(200).json({ url: session.url });
                                })
                                .catch((error) => {
                                    console.error('Chyba při vytváření Stripe session:', error);
                                    res.status(500).json({ error: 'Chyba při vytváření platby.' });
                                });
                        });
                    })
                    .catch((error) => {
                        console.error('Chyba při nahrávání souborů na S3:', error);
                        res.status(500).json({ error: 'Chyba při nahrávání souborů.' });
                    });
            });
        });
    } catch (error) {
        console.error('Chyba:', error);
        res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
    }
});

// Endpoint pro seznam objednávek
app.get('/api/orders', (req, res) => {
    console.log('Přijatý požadavek na /api/orders');
    const selectQuery = `SELECT * FROM orders ORDER BY orderDate DESC`;
    db.all(selectQuery, [], (err, rows) => {
        if (err) {
            console.error('Chyba při načítání objednávek:', err.message);
            return res.status(500).json({ error: 'Chyba při načítání objednávek.' });
        }
        console.log('Načtené objednávky:', rows);
        res.json(rows);
    });
});

// Spuštění serveru
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
