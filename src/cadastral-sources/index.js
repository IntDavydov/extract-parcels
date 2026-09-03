'use strict';

const { lookupByCadnum: lookupCom } = require('./kadastrova-karta-com');
const { lookupByCadnum: lookupComUa } = require('./kadastrova-karta-com-ua');

const SOURCES = {
  kadastrova_karta: {
    key: 'kadastrova_karta',
    label: 'kadastrova-karta.com',
    lookupByCadnum: lookupCom,
  },
  kadastrova_karta_ua: {
    key: 'kadastrova_karta_ua',
    label: 'kadastrova-karta.com.ua',
    lookupByCadnum: lookupComUa,
  },
};

function resolveSourceKey(rawKey) {
  return SOURCES[rawKey] ? rawKey : 'kadastrova_karta_ua';
}

function getSource(rawKey) {
  return SOURCES[resolveSourceKey(rawKey)];
}

module.exports = { SOURCES, resolveSourceKey, getSource };

