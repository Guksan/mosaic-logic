const AWS = require('aws-sdk');
const dotenv = require('dotenv');

// Načtení konfigurace z .env
dotenv.config();

// Inicializace S3 klienta
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const uploadToS3 = async (file) => {
    const params = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `uploads/${Date.now()}-${file.originalname}`, // Název souboru
        Body: file.buffer, // Obsah souboru
        ContentType: file.mimetype, // Typ souboru
        ACL: 'private', // Soubor nebude veřejný
    };

    try {
        const data = await s3.upload(params).promise();
        return data.Location; // URL nahraného souboru
    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw error;
    }
};

module.exports = uploadToS3;
