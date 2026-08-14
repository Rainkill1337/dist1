
import crypto from 'crypto';
const _k1 = 'dandan';
const _k2 = 'play';
const _k3 = 'open';
const _k4 = 'platform';
const _k5 = '2026';

const _i1 = 'zviewer';
const _i2 = 'service';

function decryptSecret(
  cipherTextBase64: string,
  keyParts: string[],
  ivParts: string[],
): string {
  const key = crypto
    .createHash('sha256')
    .update(keyParts.join(''), 'utf8')
    .digest();
  const iv = Buffer.from(
    crypto.createHash('sha256').update(ivParts.join(''), 'utf8').digest(),
  ).subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([
    decipher.update(cipherTextBase64, 'base64'),
    decipher.final(),
  ]).toString('utf8');
}

const _CIPHER_APP_ID = '95s9nfJw9/YvPyAQWqCRAw==';
const _CIPHER_APP_SECRET =
  'yYjKsgNaZKOAezPpT4aXfvTY2rTcwjt3OfbthKzFNBw6VBJ5x8lm+sXeX4lapT6M';

export const DANDANPLAY_APP_ID = decryptSecret(
  _CIPHER_APP_ID,
  [_k1, _k2, _k3, _k4, _k5],
  [_i1, _i2],
);

export const DANDANPLAY_APP_SECRET = decryptSecret(
  _CIPHER_APP_SECRET,
  [_k1, _k2, _k3, _k4, _k5],
  [_i1, _i2],
);
