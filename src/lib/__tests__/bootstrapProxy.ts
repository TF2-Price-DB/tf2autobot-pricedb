import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import bootstrapProxy from '../bootstrapProxy';

const run = promisify(execFile);

test('the development proxy preserves explicit TLS agents and normal certificate verification', async () => {
    // Isolate global-agent's process-wide HTTP hooks from the Jest worker.
    const script = `
        const https = require('node:https');
        const axios = require('axios');
        const forge = require('node-forge');
        (${bootstrapProxy.toString()})();
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const certificate = forge.pki.createCertificate();
        certificate.publicKey = keys.publicKey;
        certificate.serialNumber = '01';
        certificate.validity.notBefore = new Date(Date.now() - 60000);
        certificate.validity.notAfter = new Date(Date.now() + 3600000);
        const attributes = [{ name: 'commonName', value: 'localhost' }];
        certificate.setSubject(attributes);
        certificate.setIssuer(attributes);
        certificate.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
        certificate.sign(keys.privateKey, forge.md.sha256.create());
        const server = https.createServer({
            key: forge.pki.privateKeyToPem(keys.privateKey),
            cert: forge.pki.certificateToPem(certificate)
        }, (_request, response) => response.end('ok'));
        server.listen(0, '127.0.0.1', async () => {
            const url = 'https://127.0.0.1:' + server.address().port;
            const relaxed = new https.Agent({ rejectUnauthorized: false });
            const strict = new https.Agent({ rejectUnauthorized: true });
            try {
                const response = await axios.get(url, { httpsAgent: relaxed, proxy: false, timeout: 5000 });
                let strictError;
                try {
                    await axios.get(url, { httpsAgent: strict, proxy: false, timeout: 5000 });
                } catch (error) {
                    strictError = error.code;
                }
                process.stdout.write(JSON.stringify({ status: response.status, strictError }));
            } catch (error) {
                process.stderr.write(error.code || error.message);
                process.exitCode = 1;
            } finally {
                relaxed.destroy();
                strict.destroy();
                server.close();
            }
        });
    `;
    const { stdout } = await run(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        timeout: 15000,
        env: {
            ...process.env,
            GLOBAL_AGENT_HTTP_PROXY: '',
            GLOBAL_AGENT_HTTPS_PROXY: '',
            GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE: 'GLOBAL_AGENT_',
            GLOBAL_AGENT_FORCE_GLOBAL_AGENT: 'true'
        }
    });
    expect(JSON.parse(stdout)).toEqual({ status: 200, strictError: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
}, 20000);
