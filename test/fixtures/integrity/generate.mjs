#!/usr/bin/env node

/* global Buffer, console */
// Regenerates app-attest.fixture.json: a test CA chain shaped like Apple's (root P-384 →
// intermediate P-384 → leaf P-256 with the 1.2.840.113635.100.8.2 nonce extension) and a CBOR
// attestation object for a fixed challenge. Usage: node test/fixtures/integrity/generate.mjs
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'attest-'));
const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
const sha = (...b) => createHash('sha256').update(Buffer.concat(b)).digest();
const APP_ID = 'TEAMID1234.app.nouri.test';
const CHALLENGE = 'fixture-challenge-0123456789abcdef';

writeFileSync(join(dir, 'ca.cnf'), '[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
ssl('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'root.key');
ssl('req', '-x509', '-new', '-key', 'root.key', '-subj', '/CN=Test App Attestation Root CA', '-days', '7300', '-out', 'root.pem', '-extensions', 'v3_ca', '-config', 'ca.cnf', '-sha384');
ssl('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'int.key');
ssl('req', '-new', '-key', 'int.key', '-subj', '/CN=Test App Attestation CA 1', '-out', 'int.csr');
ssl('x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '7000', '-out', 'int.pem', '-extfile', 'ca.cnf', '-extensions', 'v3_ca', '-sha384');
ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');

const leafKeyPem = readFileSync(join(dir, 'leaf.key'), 'utf8');
const jwk = createPublicKey(createPrivateKey(leafKeyPem)).export({ format: 'jwk' });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
const keyId = sha(point);
const counter = Buffer.alloc(4);
const credLen = Buffer.alloc(2);
credLen.writeUInt16BE(32);
const authData = Buffer.concat([sha(Buffer.from(APP_ID)), Buffer.from([0x41]), counter, Buffer.from('appattestdevelop'), credLen, keyId, Buffer.from('a50102032620012158', 'hex')]);
const nonce = sha(authData, sha(Buffer.from(CHALLENGE)));
writeFileSync(join(dir, 'leaf.cnf'), `[v3_leaf]\nbasicConstraints=critical,CA:FALSE\n1.2.840.113635.100.8.2=DER:3024a1220420${nonce.toString('hex')}\n`);
ssl('req', '-new', '-key', 'leaf.key', '-subj', `/CN=${keyId.toString('hex')}`, '-out', 'leaf.csr');
ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-days', '6900', '-out', 'leaf.pem', '-extfile', 'leaf.cnf', '-extensions', 'v3_leaf', '-sha256');
const der = (f) => ssl('x509', '-in', f, '-outform', 'DER');

// CBOR (just what the attestation needs).
const head = (m, n) => (n < 24 ? Buffer.from([(m << 5) | n]) : n < 256 ? Buffer.from([(m << 5) | 24, n]) : Buffer.from([(m << 5) | 25, n >> 8, n & 255]));
const bytes = (b) => Buffer.concat([head(2, b.length), b]);
const text = (s) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
const attStmt = Buffer.concat([head(5, 2), text('x5c'), head(4, 2), bytes(der('leaf.pem')), bytes(der('int.pem')), text('receipt'), bytes(Buffer.from('receipt'))]);
const attestation = Buffer.concat([head(5, 3), text('fmt'), text('apple-appattest'), text('attStmt'), attStmt, text('authData'), bytes(authData)]);

writeFileSync(
  join(here, 'app-attest.fixture.json'),
  JSON.stringify(
    { appId: APP_ID, challenge: CHALLENGE, keyId: keyId.toString('base64'), attestation: attestation.toString('base64'), rootPem: readFileSync(join(dir, 'root.pem'), 'utf8'), leafKeyPem },
    null,
    2,
  ) + '\n',
);
console.warn('wrote app-attest.fixture.json');
