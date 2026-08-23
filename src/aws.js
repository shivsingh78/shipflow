import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import fs from "fs"
import dotenv from 'dotenv'
dotenv.config()

const s3 = new S3Client({
    region: process.env.AWS_REGION,  

    credentials: {
        accessKeyId:process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey:process.env.AWS_SECRET_KEY
    } 

}) 

export const uploadFile = async ( fileName, localFilePath)=>{ 
    const fileContent = fs.readFileSync(localFilePath)

    const command = new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key:fileName,
        Body:fileContent
    })
    await s3.send(command)
 
    console.log(`${fileName} uploaded successfully`);
    
}