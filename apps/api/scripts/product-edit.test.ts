import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEditPayload } from '../src/product-edit.js';

const snapshot = {
  itemId: '1094254313008',
  quantity: '1',
  freebies: 'false',
  itemTypeStr: 'b',
  itemTextDTO: { title: '旧标题', desc: '旧描述' },
  imageInfoDOList: [
    { url: 'https://img/a.png', major: 'true', widthSize: '800', heightSize: '800', type: '0', extraInfo: { isH: 'false', isT: 'false', raw: 'true' } },
    { url: 'https://img/b.jpg', major: 'false', widthSize: '1000', heightSize: '563', type: '0' },
  ],
  itemLabelExtList: [{ propertyId: '-10000', text: '数码', channelCateId: '123' }],
  userRightsProtocols: [{ enable: 'true', serviceCode: 'FAST_SHIP' }],
  itemPostFeeDTO: { canFreeShipping: 'true', supportFreight: 'false', onlyTakeSelf: 'false', postPriceInCent: '0', templateId: '0' },
  itemAddrDTO: { city: '深圳市', prov: '广东省', addressType: '5', divisionId: '440305' },
  itemCatDTO: { catId: 'cat-1', catName: '其他', channelCatId: 'ch-1', tbCatId: 'tb-1', leafId: '' },
  itemPriceDTO: { priceInCent: '1990' },
  itemSkuList: [
    { skuId: '1', priceInCent: '1990', quantity: '99', propertyList: [{ propertyText: '页数', valueText: '10页以内' }] },
    { skuId: '2', priceInCent: '2990', quantity: '99', propertyList: [{ propertyText: '页数', valueText: '20页以内' }] },
  ],
};

test('edit payload keeps the snapshot and overrides only title/description', () => {
  const { payload, changed } = buildEditPayload(snapshot, '1094254313008', { title: '新标题', description: '旧描述' });
  assert.deepEqual(changed, ['title']);
  assert.equal(payload.itemId, '1094254313008');
  assert.deepEqual(payload.itemTextDTO, { desc: '旧描述', title: '新标题', titleDescSeparate: true });
  assert.equal(payload.quantity, '1');
  assert.deepEqual(payload.itemPriceDTO, {});
  assert.deepEqual(payload.itemProperties, [{ propertyName: '页数', supportImage: false, propertyValues: [{ propertyValue: '10页以内' }, { propertyValue: '20页以内' }] }]);
  assert.deepEqual(payload.itemSkuList, [
    { priceInCent: '1990', quantity: 99, propertyList: [{ propertyText: '页数', valueText: '10页以内' }] },
    { priceInCent: '2990', quantity: 99, propertyList: [{ propertyText: '页数', valueText: '20页以内' }] },
  ]);
  const images = payload.imageInfoDOList as Array<Record<string, unknown>>;
  assert.equal(images.length, 2);
  assert.equal(images[0]!.major, true);
  assert.equal(images[1]!.widthSize, 1000);
  assert.deepEqual(payload.userRightsProtocols, [{ enable: true, serviceCode: 'FAST_SHIP' }]);
  assert.deepEqual(payload.itemPostFeeDTO, { canFreeShipping: true, supportFreight: false, onlyTakeSelf: false, postPriceInCent: '0', templateId: '0', idleTemplateId: '0' });
  assert.deepEqual(payload.itemAddrDTO, { addressType: 5, city: '深圳市', divisionId: 440305, prov: '广东省' });
  assert.deepEqual(payload.itemCatDTO, { catId: 'cat-1', catName: '其他', channelCatId: 'ch-1', tbCatId: 'tb-1' });
});

test('edit payload can change one sku price and reports it', () => {
  const { payload, changed } = buildEditPayload(snapshot, '1094254313008', { skus: [{ value: '20页以内', priceMinor: 3990, quantity: 50 }] });
  assert.deepEqual(changed, ['sku:20页以内:price', 'sku:20页以内:quantity']);
  const skus = payload.itemSkuList as Array<Record<string, unknown>>;
  assert.equal(skus[1]!.priceInCent, '3990');
  assert.equal(skus[1]!.quantity, 50);
  assert.equal(skus[0]!.priceInCent, '1990');
});

test('single-sku edit updates the top-level price', () => {
  const single = { ...snapshot, itemSkuList: [], quantity: '5' };
  const { payload, changed } = buildEditPayload(single, 'x', { priceMinor: 2500 });
  assert.deepEqual(changed, ['price']);
  assert.deepEqual(payload.itemPriceDTO, { priceInCent: '2500' });
  assert.equal(payload.quantity, 5);
  assert.equal('itemSkuList' in payload, false);
});

test('image override keeps snapshot entries, appends uploads and marks the first as major', () => {
  const kept = { url: 'https://img/b.jpg', major: 'false', widthSize: '1000', heightSize: '563', type: '0' };
  const uploaded = { url: 'https://img/new.png', widthSize: 1536, heightSize: 1024, major: 'false', type: '0', extraInfo: { isH: 'false', isT: 'false', raw: 'false' } };
  const { payload, changed } = buildEditPayload(snapshot, 'x', { images: [kept, uploaded] });
  assert.deepEqual(changed, ['images']);
  const images = payload.imageInfoDOList as Array<Record<string, unknown>>;
  assert.equal(images.length, 2);
  assert.equal(images[0]!.url, 'https://img/b.jpg');
  assert.equal(images[0]!.major, true);
  assert.equal(images[1]!.url, 'https://img/new.png');
  assert.equal(images[1]!.major, false);
  assert.equal(images[1]!.widthSize, 1536);
  assert.equal(images[1]!.status, 'done');
  const same = buildEditPayload(snapshot, 'x', { images: (snapshot.imageInfoDOList as unknown[]).map((e) => e as Record<string, unknown>) });
  assert.deepEqual(same.changed, []);
});
