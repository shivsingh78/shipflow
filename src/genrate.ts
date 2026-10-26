import crypto from "crypto";

const max_length=8
const subset="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// Release IDs end up in URLs and S3 keys, so use a fixed alphanumeric
// alphabet and a cryptographically secure random source.
export function genrate(): string{
    let ans=""
    for(let i=0;i<max_length;i++){
        ans+=subset[crypto.randomInt(subset.length)]
    }
    return ans
}
