// SDK
const functions = require('firebase-functions');
const admin = require('firebase-admin');
//
const functionCreate = require('../index.js').functionCreate;
//
const sharp = require('sharp');
const fs = require('fs-extra');
const { tmpdir } = require('os');
const { join, dirname, basename } = require('path');

const bucketName = 'events-1ee8d.appspot.com';
exports.storageTrigger = functionCreate.runWith({
    timeoutSeconds: 60,
    memory: '512MB'
}).storage.bucket(bucketName).object().onFinalize(async object => {
    const bucket = admin.storage().bucket(object.bucket); // wich bucket to use
    const filePath = object.name; // full file path
    const fileName = basename(filePath); // reference to file name
    const bucketDir = dirname(filePath); // reference to directory

    const workingDir = join(tmpdir(), 'workdir');
    const tmpFilePath = join(workingDir, fileName);
    const metadata = { contentType: object.contentType };

    if(fileName.includes('resized') || !object.contentType.includes('image')) {
        console.log('exiting function');
        return false;
    }

    // Ensure working directory exists
    await fs.ensureDir(workingDir);

    // Download source file
    await bucket.file(filePath).download({
        destination: tmpFilePath
    });

    //
    const sizes = [1200]; // 1200 x 1600

    const uploadPromises = sizes.map(async size => {
        const imageName = 'resized-' + size +'_' + fileName;
        const imagePath = join(workingDir, imageName);

        const sizeH = Math.round(size * 4/3);

        // Resize source image
        await sharp(tmpFilePath)
            .metadata()
            .then(({ width, height }) => sharp(tmpFilePath)
                .resize(size, Math.min(Math.floor((height/width)*size), sizeH), {
                    fit: 'cover'
                })
                .toFile(imagePath)
            );

        // Upload to GCS
        return bucket.upload(imagePath, {
            destination: join(bucketDir, imageName),
            metadata: metadata
        });
    });

    // Run the upload operations
    await Promise.all(uploadPromises).then(() => {
        bucket.file(filePath).delete();
        return Promise.resolve();
    }).catch(error => {
        console.log(error);
        return Promise.resolve();
    });

    // Cleanup remove the tmp/workdir from the filesystem
    return fs.remove(workingDir);
});



