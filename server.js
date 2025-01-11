const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const stripe = require('stripe');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Načtení konfigurace
dotenv.config();

// Inicializace aplikace
const app = express();
const upload = multer(); // Pro zpracování souborů v paměti
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// AWS S3 Konfigurace
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

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
      const params = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `${Date.now()}-${file.originalname}`,
        Body: file.buffer,
      };
      const command = new PutObjectCommand(params);
      await s3.send(command);
      photoUrls.push(`https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`);
    }

    // Vytvořte Stripe Checkout Session
    let priceId;
    if (package === 'Základní balíček') priceId = 'price_12345';
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

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Chyba:', error);
    res.status(500).json({ error: 'Chyba při zpracování objednávky.' });
  }
});

// Stripe Webhook
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Aktualizace stavu objednávky v databázi
      console.log(`Platba od ${session.customer_email} úspěšná.`);
    }

    res.status(200).send();
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

// Spuštění serveru
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
