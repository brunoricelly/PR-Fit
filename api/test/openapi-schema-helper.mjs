import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const openapi = yaml.load(fs.readFileSync(path.join(API, 'openapi.yaml'), 'utf8'));

export function schemaAt(ref) {
  return ref.split('/').slice(1).reduce((value, key) => value[key], openapi);
}

export function validateSchema(schema, value, at = '$') {
  if (schema.$ref) return validateSchema(schemaAt(schema.$ref), value, at);
  if (schema.oneOf) {
    const results = schema.oneOf.map(candidate => validateSchema(candidate, value, at));
    return results.filter(result => result.length === 0).length === 1 ? [] : [`${at}: oneOf did not match exactly once`];
  }
  if (schema.anyOf && !schema.anyOf.some(candidate => validateSchema(candidate, value, at).length === 0)) return [`${at}: no anyOf branch matched`];
  const errors = [];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const accepted = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (accepted.length && !accepted.includes(type) && !(accepted.includes('number') && type === 'integer')) return [`${at}: expected ${accepted.join('|')}, got ${type}`];
  if (value === null) return errors;
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateSchema(schema.properties[key], item, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected ${key}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${at}: duplicate items`);
    value.forEach((item, index) => errors.push(...validateSchema(schema.items || {}, item, `${at}[${index}]`)));
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: too long`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${at}: pattern mismatch`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: outside enum`);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: wrong const`);
  return errors;
}

export function assertSchema(assert, schema, value, label) {
  assert.deepEqual(validateSchema(schema, value), [], label);
}
