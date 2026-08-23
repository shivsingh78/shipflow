import fs from "fs";
import path from "path";

export async function getAllFiles(folderPath) {
  let response = [];

  const allFilesAndFolders = fs.readdirSync(folderPath);

  for (const file of allFilesAndFolders) {

    // Ignore directories that should not be uploaded
    if ([".git", "node_modules", "backend"].includes(file)) {
      continue;
    }

    const fullFilePath = path.join(folderPath, file);

    if (fs.statSync(fullFilePath).isDirectory()) {
      response.push(...(await getAllFiles(fullFilePath)));
    } else {
      response.push(fullFilePath);
    }
  }

  return response;
}