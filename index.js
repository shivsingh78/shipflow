import express from 'express';
import cors from 'cors';
import fs from "fs/promises"
import { genrate } from './src/genrate.js';
import simpleGit from 'simple-git';
import path from 'path'
import dotenv from "dotenv"
dotenv.config()
import { getAllFiles } from './src/file.js';
import { uploadFile } from './src/aws.js';
import { deployQueue } from './src/queue.js';
const app = express();
app.use(express.json());
app.use(cors());
const git=simpleGit()

app.post("/deploy",async (req,res)=>{
  
    try {
      const repoUrl=req.body.repoUrl;
      
    const id=genrate()
    const outerPath=path.join(process.cwd(),"output",id);
    
    await git.clone(repoUrl,outerPath);
    console.log("start");
    
    const files= await getAllFiles(outerPath)
    console.log(files);
    
    for(const file of files) {
      const key= path.relative(
        process.cwd(),
        file 
      )
      await uploadFile(
        key,
        file
      )
    }
    await fs.rm(
      outerPath,
      {recursive:true,
        force:true,
      }
    )
    await deployQueue.add(
      "deployment",
      {
        id
      } 
    )
     
    console.log(await deployQueue.getJobCounts());
    console.log(await deployQueue.getJobs());
    
    
    res.status(200).json({message: " uploaded"})
    } catch (error) {
      console.log(error);
      
      res.status(500).json({message: "deployment error"}) 
    }

    
    
}) 




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

