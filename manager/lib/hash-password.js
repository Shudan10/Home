/**
 * Reads a password on stdin and prints the value for ADMIN_PASSWORD_HASH.
 *
 *   printf '%s' 'secret' | docker run --rm -i quickstart-home/manager:1 node lib/hash-password.js
 *
 * The installer uses this so it never has to reimplement the hashing scheme,
 * and so the password is never passed as a command-line argument.
 */
import { hashPassword } from './auth.js';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    data += chunk;
});
process.stdin.on('end', () => {
    // A trailing line ending is trimmed so a password piped from `printf` and
    // one piped from `echo` hash to the same value.
    process.stdout.write(hashPassword(data.replace(/\r?\n$/, '')));
});
