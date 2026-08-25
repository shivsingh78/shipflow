import http from "http";
import https from "https";

function request(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https://")
      ? https
      : http;

    const req = client.get(url, (res) => {
      const statusCode = res.statusCode ?? 0;

      // We don't need the entire response body.
      res.resume();

      resolve(statusCode);
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(
        new Error(
          `Health check timed out after ${timeout}ms`
        )
      );
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

export async function verifyRelease({
  releaseId,
  deploymentUrl,
}) {
  console.log(`Verifying release ${releaseId}`);
  console.log(`Deployment URL: ${deploymentUrl}`);

  if (!deploymentUrl) {
    throw new Error(
      "Deployment URL is required for verification"
    );
  }

  const statusCode = await request(
    deploymentUrl
  );

  console.log(
    `Health check status: ${statusCode}`
  );

  if (statusCode < 200 || statusCode >= 400) {
    throw new Error(
      `Deployment health check failed with status ${statusCode}`
    );
  }

  console.log(
    `Verification successful for ${releaseId}`
  );

  return {
    releaseId,
    deploymentUrl,
    statusCode,
    healthy: true,
  };
}