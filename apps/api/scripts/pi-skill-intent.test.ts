import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PiSkillManager, isInstallableSkillSource } from '../src/pi-skills.js';

describe('Pi Skill instruction routing', () => {
  it('does not treat chat messages with download links as a Skill install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-skill-intent-'));
    let fetched = 0;
    const manager = new PiSkillManager({ rootDir: root, fetchImpl: (async () => { fetched += 1; return new Response('<html></html>'); }) as typeof fetch });
    const message = '先搞一个卡密 使用说明：工具下载地址： https://liver.lanzoul.com/b013a3fv0f 备用下载： https://agwx.lanzn.com/s/AGNB';
    assert.equal(await manager.handleInstruction({ adminId: 'admin-1', instruction: message }), undefined);
    assert.equal(await manager.handleInstruction({ adminId: 'admin-1', instruction: '账号登录失效了怎么办' }), undefined);
    assert.equal(fetched, 0);
  });

  it('recognizes installable sources only', () => {
    assert.equal(isInstallableSkillSource('https://liver.lanzoul.com/b013a3fv0f'), false);
    assert.equal(isInstallableSkillSource('https://github.com/acme/quark-skill'), true);
    assert.equal(isInstallableSkillSource('https://example.com/pkg/skill.zip'), true);
    assert.equal(isInstallableSkillSource('https://example.com/pkg/skill.tar.gz?x=1'), true);
  });
});
