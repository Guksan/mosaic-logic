const express = require('express');
const multer = require('multer');
const stripe = require('stripe');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

// Načtení konfigurace
dotenv.config();

// Inicializace aplikace
const app = express();
app.use(cors());

// Parsování raw body pro Stripe webhook
app.use('/webhook', express.raw({type: 'application/json'}));

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

// Inicializace PostgreSQL databáze
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Vytvoření tabulky objednávek
const createTableQuery = `
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    package TEXT NOT NULL,
    files TEXT NOT NULL,
    paymentStatus TEXT DEFAULT 'Pending',
    orderDate TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

// Vytvoření tabulky při startu aplikace
pool.query(createTableQuery)
    .then(() => console.log('Tabulka orders existuje nebo byla vytvořena'))
    .catch(err => console.error('Chyba při vytváření tabulky:', err));

// Webhook endpoint pro Stripe
app.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripeClient.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        try {
            await pool.query(
                'UPDATE orders SET paymentStatus = $1 WHERE id = $2',
                ['Completed', session.metadata.orderId]
            );
            console.log(`✓ Platba dokončena pro objednávku ${session.metadata.orderId}`);
        } catch (error) {
            console.error('Chyba při aktualizaci statusu:', error);
        }
    }

    res.json({received: true});
});

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
        const result = await pool.query(
            'INSERT INTO orders (email, package, files, paymentStatus) VALUES ($1, $2, $3, $4) RETURNING id',
            [email, package, JSON.stringify([]), 'Awaiting Payment']
        );
        const orderId = result.rows[0].id;

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
        await pool.query(
            'UPDATE orders SET files = $1 WHERE id = $2',
            [JSON.stringify(uploadedUrls), orderId]
        );

        // 5. Vytvoření Stripe checkout session
        let priceId;
        if (package === 'Základní balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
        if (package === 'Pokročilý balíček') priceId = 'price_1QifO4KOjxPRwLQE2p03qG9Y';
        if (package === 'Prémiový balíček') priceId = 'price_1QifRaKOjxPRwLQEcDu1wjsX';

        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: 'https://www.mosaicprovisuals.com/success',
            cancel_url: 'https://mosaicprovisuals.com',
            locale: 'cs',
            metadata: {
                orderId: orderId
            }
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
        const result = await pool.query(
            'INSERT INTO orders (email, package, files, paymentStatus) VALUES ($1, $2, $3, $4) RETURNING id',
            [email, 'Free', JSON.stringify([]), 'Completed']
        );
        const orderId = result.rows[0].id;

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
        await pool.query(
            'UPDATE orders SET files = $1 WHERE id = $2',
            [JSON.stringify([fileUrl]), orderId]
        );

        res.status(200).json({ message: 'Fotografie byla úspěšně nahrána.', orderId });
    } catch (error) {
        console.error('Chyba při zpracování "Free" objednávky:', error);
        res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
    }
});

// Endpoint pro seznam objednávek
app.get('/api/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY orderDate DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Chyba při načítání objednávek:', error);
        res.status(500).json({ error: 'Chyba při načítání objednávek.' });
    }
});

// Spuštění serveru
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));