const express = require('express');
const multer = require('multer');
const stripe = require('stripe');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

// Načtení konfigurace
dotenv.config();

// Inicializace aplikace
const app = express();
app.use(cors());
const upload = multer({
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit na soubor
    }
});
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
db.run(createTableQuery);

// Middleware pro kontrolu počtu souborů podle balíčku
const checkFileLimit = (req, res, next) => {
    const package = req.body.package;
    let fileLimit;
    
    switch (package) {
        case 'Základní balíček':
            fileLimit = 5;
            break;
        case 'Pokročilý balíček':
            fileLimit = 10;
            break;
        case 'Prémiový balíček':
            fileLimit = 15;
            break;
        default:
            fileLimit = 5;
    }

    if (req.files && req.files.length > fileLimit) {
        return res.status(400).json({ 
            error: `Překročen limit počtu souborů pro ${package}. Maximum je ${fileLimit} souborů.` 
        });
    }
    next();
};

// Endpoint pro vytvoření objednávky
app.post('/api/orders/create', upload.array('photos', 15), checkFileLimit, async (req, res) => {
    const { email, package } = req.body;
    const files = req.files;

    try {
        // 1. Vložení objednávky do databáze a získání jejího ID
        const orderId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO orders (email, package, files, paymentStatus) VALUES (?, ?, ?, ?)',
                [email, package, JSON.stringify([]), 'Awaiting Payment'],
                function (err) {
                    if (err) reject(err);
                    resolve(this.lastID);
                }
            );
        });

        // 2. Použití orderId pro název složky v S3
        const folderKey = `orders/${orderId}/`;

        // 3. Nahrávání souborů na S3
        const uploadPromises = files.map(async (file, index) => {
            const fileKey = `${folderKey}${Date.now()}-${index}-${file.originalname}`;
            const params = {
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: fileKey,
                Body: file.buffer,
                ContentType: file.mimetype,
            };

            await s3.send(new PutObjectCommand(params));

            const fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;
            return fileUrl;
        });

        const uploadedUrls = await Promise.all(uploadPromises);

        // 4. Aktualizace databáze s URL souborů
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE orders SET files = ? WHERE id = ?',
                [JSON.stringify(uploadedUrls), orderId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        // 5. Vytvoření Stripe checkout session
        let priceId;
        if (package === 'Základní balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
        if (package === 'Pokročilý balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
        if (package === 'Prémiový balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';

        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: `https://your-domain.com/success?orderId=${orderId}`,
            cancel_url: 'https://your-domain.com/cancel',
        });

        // Vrácení URL pro otevření v novém okně
        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Chyba při zpracování:', error);
        res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
    }
});

// Endpoint pro "Free" objednávky
app.post('/api/orders/free', upload.single('photo'), async (req, res) => {
    const { email } = req.body;
    const file = req.file;

    try {
        if (!file) {
            return res.status(400).json({ error: 'Prosím nahrajte jednu fotografii.' });
        }

        // Vložení "Free" objednávky do databáze
        const orderId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO orders (email, package, files, paymentStatus) VALUES (?, ?, ?, ?)',
                [email, 'Free', JSON.stringify([]), 'Completed'],
                function (err) {
                    if (err) reject(err);
                    resolve(this.lastID);
                }
            );
        });

        // Nahrání souboru na S3
        const folderKey = `orders/${orderId}/`;
        const fileKey = `${folderKey}${Date.now()}-${file.originalname}`;
        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: fileKey,
            Body: file.buffer,
            ContentType: file.mimetype,
        };

        await s3.send(new PutObjectCommand(params));

        const fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;

        // Aktualizace databáze s URL fotografie
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE orders SET files = ? WHERE id = ?',
                [JSON.stringify([fileUrl]), orderId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.status(200).json({ message: 'Fotografie byla úspěšně nahrána.', orderId });
    } catch (error) {
        console.error('Chyba při zpracování "Free" objednávky:', error);
        res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
    }
});

// Endpoint pro seznam objednávek
app.get('/api/orders', (req, res) => {
    db.all('SELECT * FROM orders ORDER BY orderDate DESC', [], (err, rows) => {
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
