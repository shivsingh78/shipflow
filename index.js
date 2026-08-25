import express from 'express';
import cors from 'cors';
import fs from "fs/promises"
import { genrate } from './src/genrate.js';
import path from 'path'
import dotenv from "dotenv"
import { deployQueue } from "./src/queue.js";
dotenv.config()
import {
  createRelease
} from "./src/releaseStore.js";
import { pool } from './src/db.js';
import { rollbackRelease } from "./src/rollback.js";
import { getS3Object } from "./src/aws.js";

const app = express();
app.use(express.json());
app.use(cors());


async function serveActiveFile(
  requestedPath,
  req,
  res
) {
  try {
    const cleanPath =
      requestedPath
        .replace(/^\/+/, "")
        .replace(/\.\./g, "");

    const key =
      `active/${cleanPath || "index.html"}`;

    const result =
      await getS3Object(key);

    if (!result.Body) {
      return res
        .status(404)
        .send("Deployment file not found");
    }

    if (result.ContentType) {
      res.setHeader(
        "Content-Type",
        result.ContentType
      );
    }

    const body =
      await result.Body.transformToByteArray();

    return res.send(
      Buffer.from(body)
    );
  } catch (error) {
    console.error(
      "Active deployment error:",
      error
    );

    return res
      .status(404)
      .send("Deployment file not found");
  }
}


app.get(
  "/active",
  async (req, res) => {
    await serveActiveFile(
      "index.html",
      req,
      res
    );
  }
);

app.get(
  "/active/*splat",
  async (req, res) => {
    const splat = req.params.splat;

    const requestedPath =
      Array.isArray(splat)
        ? splat.join("/")
        : splat || "index.html";

    await serveActiveFile(
      requestedPath,
      req,
      res
    );
  }
);

app.post(
  "/rollback/:releaseId",
  async (req, res) => {
    try {
      const { releaseId } =
        req.params;

      const rollback =
        await rollbackRelease(
          releaseId
        );

      return res.status(200).json({
        success: true,
        message:
          "Rollback completed",
        rollback,
      });
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message:
          error.message,
      });
    }
  }
);

//testing route
// app.post("/rollback/:releaseId", async (req, res) => {
//   try {
//     const { releaseId } = req.params;

//     const rollback = await rollbackRelease(
//       releaseId
//     );

//     return res.status(200).json({
//       success: true,
//       message: "Rollback target selected",
//       rollback,
//     });
//   } catch (error) {
//     console.error(error);

//     return res.status(500).json({
//       success: false,
//       message: error.message,
//     });
//   }
// });



app.get(
  "/deployments/:releaseId",
  async (req, res) => {
    const { releaseId } = req.params;

    const indexPath = path.join(
      process.cwd(),
      "output",
      releaseId,
      "dist",
      "index.html"
    );

    try {
      await fs.access(indexPath);
      res.sendFile(indexPath);
    } catch {
      res.status(404).json({
        success: false,
        message: "Deployment not found",
      });
    }
  }
);

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

