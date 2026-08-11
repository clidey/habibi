const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');
const supervisor = path.join(root, 'native', 'openwa-supervisor.js');

const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('the OpenWA supervisor kills its service after the Habibi parent exits', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-openwa-supervisor-'));
  const service = path.join(temporary, 'service.js');
  const pidFile = path.join(temporary, 'service.pid');
  fs.writeFileSync(service, `require('node:fs').writeFileSync(process.env.OPENWA_TEST_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);`);

  try {
    const helperSource = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, [${JSON.stringify(supervisor)}, ${JSON.stringify(service)}], {
        env:{ ...process.env, HABIBI_PARENT_PID:String(process.pid), OPENWA_TEST_PID_FILE:${JSON.stringify(pidFile)} },
        stdio:'ignore'
      });
      setTimeout(() => process.exit(0), 500);
    `;
    const helper = spawn(process.execPath, ['-e', helperSource], { stdio:'ignore' });
    await new Promise((resolve, reject) => {
      helper.once('error', reject);
      helper.once('exit', code => code === 0 ? resolve() : reject(new Error(`helper exited ${code}`)));
    });

    for (let attempt = 0; attempt < 30 && !fs.existsSync(pidFile); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(pidFile), true, 'the supervised service should start');
    const servicePid = Number(fs.readFileSync(pidFile, 'utf8'));
    for (let attempt = 0; attempt < 50 && isAlive(servicePid); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(isAlive(servicePid), false, 'the service must exit when its native parent disappears');
  } finally {
    fs.rmSync(temporary, { recursive:true, force:true });
  }
});
