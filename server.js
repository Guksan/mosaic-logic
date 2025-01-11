const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const stripe = require('stripe');
const dotenv = require('dotenv');
const uploadToS3 = require('./utils/uploadToS3');

// Načtení konfigurace z .env
dotenv.config();
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// Inicializace aplikace
const app = express();
const upload = multer(); // Middleware pro zpracování souborů

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Endpoint pro vytvoření objednávky
app.post('/api/orders/create', upload.array('photos'), async (req, res) => {
    const { email, package } = req.body;
    const files = req.files;
    const photoUrls = [];

    try {
        // Nahrajte fotografie na S3
        for (const file of files) {
            const photoUrl = await uploadToS3(file);
            photoUrls.push(photoUrl);
        }

        // Vytvořte Stripe Checkout Session
        let priceId;
        if (package === 'Základní balíček') priceId = 'price_12345'; // Vyměňte za skutečné ID
        if (package === 'Pokročilý balíček') priceId = 'price_67890';
        if (package === 'Prémiový balíček') priceId = 'price_abcdef';

        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: 'https://your-domain.com/success',
            cancel_url: 'https://your-domain.com/cancel',
        });

        // Odpověď s URL pro Stripe Checkout
        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Error processing order:', error);
        res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
    }
});

// Stripe Webhook
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];

    try {
        const event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

        if (event.type === 'checkout.session.completed') {
            console.log('Payment successful for session:', event.data.object.id);
        }

        res.status(200).send();
    } catch (error) {
        console.error('Webhook error:', error.message);
        res.status(400).send(`Webhook Error: ${error.message}`);
    }
});

// Spuštění serveru
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server běží na https://localhost:${PORT}`));
