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
import {
  createRelease
} from "./src/releaseStore.js";
import { pool } from './src/db.js';



const app = express();
app.use(express.json());
app.use(cors());
const git=simpleGit()

//Postgrees connect

pool.query("SELECT NOW()")
.then((result)=>{
console.log("PostgreSQL connected", result.rows[0])
})
.catch((error)=>{
  console.error("Postgress connnection failed",error);
  
})

app.post("/deploy",async (req,res)=> {
  try {
    const {repoUrl} = req.body;
    if(!repoUrl){
      return res.status(400).json({
        success:false,
        message: "repoUrl is missing",
      })
    }
    const releaseId = genrate();
    console.log(releaseId);
      const release=await createRelease({
        releaseId,
        repoUrl,
        status: "QUEUED",
        currentStage: "RELEASE"
        
      })

      await deployQueue.add("deployment", {
        releaseId,
        repoUrl
      })
      console.log("Release created:", release);

      return res.status(202).json({
      success: true,
      message: "Release queued",
      release
    });

      
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success:false,
      message: "Failed to create release"
    })
    
  }
})

// app.post("/deploy",async (req,res)=>{
  
//     try {
//       const repoUrl=req.body.repoUrl;
      
//     const id=genrate()
//     const outerPath=path.join(process.cwd(),"output",id);
    
//     await git.clone(repoUrl,outerPath);
//     console.log("start");
    
//     const files= await getAllFiles(outerPath)
//     console.log(files);
    
//     for(const file of files) {
//       const key= path.relative(
//         process.cwd(),
//         file 
//       )
//       await uploadFile(
//         key,
//         file
//       )
//     }
//     await fs.rm(
//       outerPath,
//       {recursive:true,
//         force:true,
//       }
//     )
//     await deployQueue.add(
//       "deployment",
//       {
//         id
//       } 
//     )
     
//     console.log(await deployQueue.getJobCounts());
//     console.log(await deployQueue.getJobs());
    
    
//     res.status(200).json({message: " uploaded"})
//     } catch (error) {
//       console.log(error);
      
//       res.status(500).json({message: "deployment error"}) 
//     }

    
    
// }) 




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

