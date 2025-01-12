const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const stripe = require('stripe');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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

// Připojení k MongoDB
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('Připojeno k MongoDB'))
.catch(err => console.error('Chyba při připojení k MongoDB:', err));

// Vytvoření schématu a modelu pro objednávky
const OrderSchema = new mongoose.Schema({
    email: String,
    package: String,
    files: [String],
    paymentStatus: { type: String, default: 'Pending' },
    orderDate: { type: Date, default: Date.now },
});
const Order = mongoose.model('Order', OrderSchema);

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

        // Vytvoření objednávky v databázi
        const newOrder = new Order({
            email,
            package,
            files: photoUrls,
        });
        await newOrder.save();

        // Stripe Checkout Session
        let priceId;
        if (package === 'Základní balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
        if (package === 'Pokročilý balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';
        if (package === 'Prémiový balíček') priceId = 'price_1QgD6zKOjxPRwLQE6sc5mzB0';

        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: `https://your-domain.com/success?orderId=${newOrder._id}`,
            cancel_url: 'https://your-domain.com/cancel',
        });

        // Aktualizace odkazu na platbu v databázi
        newOrder.paymentStatus = 'Awaiting Payment';
        await newOrder.save();

        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Chyba:', error);
        res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
    }
});

// Endpoint pro seznam objednávek
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (error) {
        res.status(500).send({ error: 'Chyba při získávání objednávek.' });
    }
});

// Spuštění serveru
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
