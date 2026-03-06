/**
 * Debug script to trace the "input.replace is not a function" error
 * Run: node test_fiel_debug.mjs [password]
 */
import { Credential } from '@nodecfdi/credentials/node';
import { Fiel } from '@nodecfdi/sat-ws-descarga-masiva';
import forge from '@vilic/node-forge';

// Patch decode64 to trace when it's called with non-string
const origDecode64 = forge.util.decode64.bind(forge.util);
forge.util.decode64 = function(input) {
  if (typeof input !== 'string') {
    const err = new TypeError(`input.replace is not a function (input is ${typeof input}: ${JSON.stringify(input)?.substring(0, 50)})`);
    err.stack = `decode64 called with non-string!\n${new Error().stack}`;
    throw err;
  }
  return origDecode64(input);
};

const cerPath = 'uploads/certs/MESP980407UD4/cer.cer';
const keyPath = 'uploads/certs/MESP980407UD4/key.key';
const password = process.argv[2] || 'WRONG_TEST_PASS';

console.log('Testing Credential.openFiles with password:', JSON.stringify(password.substring(0, 3) + '***'));

try {
  const credential = Credential.openFiles(cerPath, keyPath, password);
  console.log('✅ Credential created OK');
  console.log('  RFC:', credential.certificate().rfc());
  const fiel = Fiel.create(credential);
  console.log('✅ Fiel created OK, valid:', fiel.isValid());
} catch(e) {
  console.error('❌ Error:', e.message);
  if (e.stack) console.error('Stack:\n', e.stack.substring(0, 1500));
}
