import { describe, expect, it } from 'vitest';
import { readableXianyuMessage } from './controller';

describe('readableXianyuMessage', () => {
  it('strips the MTOP error code prefix', () => {
    expect(readableXianyuMessage('FAIL_BIZ_TITLE_LENGTH_TOO_LONG::标题不能超过30个字，需要修改后才能发布哦~')).toBe('标题不能超过30个字，需要修改后才能发布哦~');
    expect(readableXianyuMessage('普通原因')).toBe('普通原因');
  });
});
