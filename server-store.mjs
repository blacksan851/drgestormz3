import fs from 'fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import { createClient } from '@supabase/supabase-js';

const DATA_DIR = path.resolve(process.cwd(), 'server-data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const TEMP_FILE = path.join(DATA_DIR, 'store.tmp.json');
const STORAGE_DRIVER = String(process.env.STORAGE_DRIVER || 'file').trim().toLowerCase();
const STATE_KEY = 'app_state';
const MYSQL_TABLE = /^[a-zA-Z0-9_]+$/.test(String(process.env.DB_TABLE || '').trim())
  ? String(process.env.DB_TABLE || '').trim()
  : 'dr_gestor_store';
const SUPABASE_SCHEMA = /^[a-zA-Z0-9_]+$/.test(String(process.env.SUPABASE_SCHEMA || '').trim())
  ? String(process.env.SUPABASE_SCHEMA || '').trim()
  : 'public';
const SUPABASE_TABLE = /^[a-zA-Z0-9_]+$/.test(String(process.env.SUPABASE_TABLE || '').trim())
  ? String(process.env.SUPABASE_TABLE || '').trim()
  : 'dr_gestor_store';

let poolPromise;
let mysqlReadyPromise;
let supabaseClient;
let supabaseReadyPromise;
let writeQueue = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseStateJson(raw) {
  return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
}

function buildUrlFromBase(baseUrl, pathname) {
  if (!baseUrl) {
    return undefined;
  }

  try {
    const url = new URL(baseUrl);
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function hydrateApp(app) {
  const signupFallback = buildUrlFromBase(app.url, '/register');
  const dashboardFallback = buildUrlFromBase(app.url, '/dashboard');

  return {
    id: app.id || `app-${Date.now()}`,
    name: app.name || 'Novo aplicativo',
    url: app.url || '',
    onboardingUrl: (app.onboardingUrl || signupFallback || '').trim() || undefined,
    dashboardUrl: (app.dashboardUrl || dashboardFallback || app.url || '').trim() || undefined,
    successRedirect: app.successRedirect || 'signup',
    status: app.status || 'active',
  };
}

function calculateNextChargeDate(referenceDate, recurrence) {
  const nextCharge = new Date(referenceDate);

  if (recurrence === 'monthly') {
    nextCharge.setMonth(nextCharge.getMonth() + 1);
  } else {
    nextCharge.setFullYear(nextCharge.getFullYear() + 1);
  }

  return nextCharge.toISOString();
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('pt-MZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function getDefaultState() {
  return {
    products: [],
    apps: [],
    customers: [],
    subscriptions: [],
    users: [],
    caixas: [],
    config: {
      storeName: '',
      themeColor: 'emerald',
      requireNUIT: false,
      requireEmail: true,
      defaultMethod: 'mpesa',
      headline: '',
      subheadline: '',
      ctaLabel: '',
      urgencyText: '',
      guaranteeText: '',
      supportLine: '',
      testimonialQuote: '',
      testimonialAuthor: '',
      benefitBullets: [],
    },
    logs: [],
    paymentConfig: {
      apiKey: '',
      webhookSecret: '',
      environment: 'Producao',
      generatedWebhook: '',
      isConfigured: false,
    },
    pendingPayments: {},
  };
}

function normalizeState(rawState) {
  const defaults = getDefaultState();
  const state = rawState && typeof rawState === 'object' ? rawState : {};

  return {
    products: Array.isArray(state.products) ? state.products : defaults.products,
    apps: Array.isArray(state.apps) ? state.apps.map((app) => hydrateApp(app)) : defaults.apps,
    customers: Array.isArray(state.customers) ? state.customers : defaults.customers,
    subscriptions: Array.isArray(state.subscriptions) ? state.subscriptions : defaults.subscriptions,
    users: Array.isArray(state.users) ? state.users : defaults.users,
    caixas: Array.isArray(state.caixas) ? state.caixas : defaults.caixas,
    config: { ...defaults.config, ...(state.config || {}) },
    logs: Array.isArray(state.logs) ? state.logs : defaults.logs,
    paymentConfig: { ...defaults.paymentConfig, ...(state.paymentConfig || {}) },
    pendingPayments: state.pendingPayments && typeof state.pendingPayments === 'object' ? state.pendingPayments : {},
  };
}

function sanitizePaymentConfig(paymentConfig) {
  return {
    apiKey: '',
    webhookSecret: '',
    environment: paymentConfig.environment,
    generatedWebhook: paymentConfig.generatedWebhook,
    isConfigured: paymentConfig.isConfigured,
    hasApiKey: paymentConfig.apiKey.trim() !== '',
    hasWebhookSecret: paymentConfig.webhookSecret.trim() !== '',
  };
}

function isMySqlEnabled() {
  return STORAGE_DRIVER === 'mysql';
}

function isSupabaseEnabled() {
  return STORAGE_DRIVER === 'supabase';
}

function buildMySqlConfig() {
  const host = String(process.env.DB_HOST || '').trim();
  const port = Number(process.env.DB_PORT || 3306);
  const database = String(process.env.DB_NAME || '').trim();
  const user = String(process.env.DB_USER || '').trim();
  const password = String(process.env.DB_PASSWORD || '');
  const useSsl = ['1', 'true', 'yes'].includes(String(process.env.DB_SSL || '').trim().toLowerCase());

  if (!host || !database || !user) {
    throw new Error('Modo mysql ativo, mas faltam DB_HOST, DB_NAME ou DB_USER.');
  }

  return {
    host,
    port: Number.isFinite(port) ? port : 3306,
    database,
    user,
    password,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  };
}

async function getMySqlPool() {
  if (!poolPromise) {
    poolPromise = Promise.resolve(mysql.createPool(buildMySqlConfig()));
  }

  return poolPromise;
}

function buildSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url || !serviceRoleKey) {
    throw new Error('Modo supabase ativo, mas faltam SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY.');
  }

  return {
    url,
    serviceRoleKey,
    schema: SUPABASE_SCHEMA,
    table: SUPABASE_TABLE,
  };
}

function getSupabaseClient() {
  if (!supabaseClient) {
    const { url, serviceRoleKey, schema } = buildSupabaseConfig();
    supabaseClient = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      db: {
        schema,
      },
    });
  }

  return supabaseClient;
}

function getSupabaseTableClient() {
  const { table } = buildSupabaseConfig();
  return getSupabaseClient().from(table);
}

function throwSupabaseError(action, error) {
  if (!error) {
    return;
  }

  const detail = [error.message, error.details, error.hint].filter(Boolean).join(' | ');
  throw new Error(
    `Falha ao ${action} no Supabase: ${detail || 'verifique as credenciais, schema e tabela configurados.'}`,
  );
}

async function writeFileSnapshot(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function readSeedState() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    return normalizeState(parseStateJson(raw));
  } catch {
    return getDefaultState();
  }
}

async function ensureMySqlStorage() {
  if (!mysqlReadyPromise) {
    mysqlReadyPromise = (async () => {
      const pool = await getMySqlPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS \`${MYSQL_TABLE}\` (
          store_key VARCHAR(100) NOT NULL PRIMARY KEY,
          store_value LONGTEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const [rows] = await pool.query(`SELECT store_value FROM \`${MYSQL_TABLE}\` WHERE store_key = ? LIMIT 1`, [STATE_KEY]);
      if (!Array.isArray(rows) || rows.length === 0) {
        const seedState = await readSeedState();
        await pool.query(
          `INSERT INTO \`${MYSQL_TABLE}\` (store_key, store_value) VALUES (?, ?)`,
          [STATE_KEY, JSON.stringify(seedState)],
        );
      }
    })();
  }

  return mysqlReadyPromise;
}

async function ensureSupabaseStorage() {
  if (!supabaseReadyPromise) {
    supabaseReadyPromise = (async () => {
      const table = getSupabaseTableClient();
      const { data, error } = await table
        .select('store_key')
        .eq('store_key', STATE_KEY)
        .maybeSingle();

      throwSupabaseError(
        `validar a tabela ${SUPABASE_SCHEMA}.${SUPABASE_TABLE}`,
        error,
      );

      if (!data) {
        const seedState = await readSeedState();
        const { error: seedError } = await table.upsert(
          {
            store_key: STATE_KEY,
            store_value: seedState,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'store_key' },
        );

        throwSupabaseError(
          `criar o registo inicial em ${SUPABASE_SCHEMA}.${SUPABASE_TABLE}`,
          seedError,
        );
        await writeFileSnapshot(seedState);
      }
    })();
  }

  return supabaseReadyPromise;
}

async function readMySqlState() {
  await ensureMySqlStorage();
  const pool = await getMySqlPool();
  const [rows] = await pool.query(`SELECT store_value FROM \`${MYSQL_TABLE}\` WHERE store_key = ? LIMIT 1`, [STATE_KEY]);
  const rawState = Array.isArray(rows) && rows[0] ? rows[0].store_value : '{}';
  return normalizeState(JSON.parse(rawState));
}

async function writeMySqlState(nextState) {
  await ensureMySqlStorage();
  const pool = await getMySqlPool();
  await pool.query(
    `
      INSERT INTO \`${MYSQL_TABLE}\` (store_key, store_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE
        store_value = VALUES(store_value),
        updated_at = CURRENT_TIMESTAMP
    `,
    [STATE_KEY, JSON.stringify(nextState)],
  );
  await writeFileSnapshot(nextState);
  return nextState;
}

async function readSupabaseState() {
  await ensureSupabaseStorage();
  const { data, error } = await getSupabaseTableClient()
    .select('store_value')
    .eq('store_key', STATE_KEY)
    .maybeSingle();

  throwSupabaseError(`ler dados de ${SUPABASE_SCHEMA}.${SUPABASE_TABLE}`, error);

  const rawState = data?.store_value ?? {};
  return normalizeState(typeof rawState === 'string' ? parseStateJson(rawState) : rawState);
}

async function writeSupabaseState(nextState) {
  await ensureSupabaseStorage();
  const { error } = await getSupabaseTableClient().upsert(
    {
      store_key: STATE_KEY,
      store_value: nextState,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'store_key' },
  );

  throwSupabaseError(`gravar dados em ${SUPABASE_SCHEMA}.${SUPABASE_TABLE}`, error);
  await writeFileSnapshot(nextState);
  return nextState;
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(STORE_FILE);
  } catch {
    await fs.writeFile(STORE_FILE, JSON.stringify(getDefaultState(), null, 2), 'utf8');
  }
}

async function readFileState() {
  await ensureDataFile();
  const raw = await fs.readFile(STORE_FILE, 'utf8');
  return normalizeState(parseStateJson(raw));
}

async function writeFileState(nextState) {
  await ensureDataFile();
  await fs.writeFile(TEMP_FILE, JSON.stringify(nextState, null, 2), 'utf8');
  await fs.rename(TEMP_FILE, STORE_FILE);
  return nextState;
}

async function readStorageState() {
  if (isSupabaseEnabled()) {
    return readSupabaseState();
  }

  return isMySqlEnabled() ? readMySqlState() : readFileState();
}

async function writeStorageState(nextState) {
  if (isSupabaseEnabled()) {
    return writeSupabaseState(nextState);
  }

  return isMySqlEnabled() ? writeMySqlState(nextState) : writeFileState(nextState);
}

export function getStorageDriver() {
  if (isSupabaseEnabled()) {
    return 'supabase';
  }

  return isMySqlEnabled() ? 'mysql' : 'file';
}

export function sanitizeState(internalState) {
  return {
    products: clone(internalState.products),
    apps: clone(internalState.apps),
    customers: clone(internalState.customers),
    subscriptions: clone(internalState.subscriptions),
    users: clone(internalState.users),
    caixas: clone(internalState.caixas),
    config: clone(internalState.config),
    logs: clone(internalState.logs),
    paymentConfig: sanitizePaymentConfig(internalState.paymentConfig),
  };
}

export async function readInternalState() {
  return readStorageState();
}

async function writeInternalState(nextState) {
  return writeStorageState(nextState);
}

export function updateInternalState(mutator) {
  writeQueue = writeQueue.then(async () => {
    const currentState = await readInternalState();
    const workingCopy = clone(currentState);
    const mutated = await mutator(workingCopy);
    const nextState = normalizeState(mutated || workingCopy);
    await writeInternalState(nextState);
    return nextState;
  });

  return writeQueue;
}

export async function getPublicState() {
  const internalState = await readInternalState();
  return sanitizeState(internalState);
}

export async function replaceResource(resource, value) {
  return sanitizeState(await updateInternalState((state) => {
    switch (resource) {
      case 'products':
      case 'apps':
      case 'customers':
      case 'subscriptions':
      case 'logs':
        state[resource] = Array.isArray(value) ? value : state[resource];
        break;
      case 'config':
        state.config = { ...state.config, ...(value || {}) };
        break;
      case 'paymentConfig':
        state.paymentConfig = { ...state.paymentConfig, ...(value || {}) };
        break;
      default:
        throw new Error('Recurso invalido.');
    }

    return state;
  }));
}

export async function savePaymentConfig({ apiKey, webhookSecret, environment, generatedWebhook }) {
  const nextState = await updateInternalState((state) => {
    state.paymentConfig = {
      apiKey: String(apiKey || '').trim(),
      webhookSecret: String(webhookSecret || '').trim(),
      environment: environment || 'Producao',
      generatedWebhook: String(generatedWebhook || '').trim(),
      isConfigured: String(apiKey || '').trim() !== '',
    };

    return state;
  });

  return sanitizePaymentConfig(nextState.paymentConfig);
}

export async function getProviderConfig() {
  const state = await readInternalState();
  return state.paymentConfig;
}

export async function recordPendingPayment(payment) {
  const nextState = await updateInternalState((state) => {
    state.pendingPayments[payment.reference] = payment;

    const checkoutLog = {
      id: `${Date.now()}-pending`,
      type: 'Pedido PaySuite criado',
      status: 'pending',
      date: formatDateTime(payment.createdAt),
      createdAt: payment.createdAt,
      transactionId: payment.reference,
      checkoutUrl: payment.checkoutUrl,
      amount: payment.amount,
      customerName: payment.customerName,
      customerEmail: payment.customerEmail || undefined,
      customerPhone: payment.customerPhone,
      customerNUIT: payment.customerNUIT || undefined,
      paymentMethod: payment.paymentMethod,
      productId: payment.productId,
      productName: payment.productName,
      providerRef: payment.paymentId,
    };

    state.logs = [checkoutLog, ...state.logs.filter((log) => log.transactionId !== payment.reference)];
    return state;
  });

  return nextState.pendingPayments[payment.reference];
}

export async function getPendingPayment(reference) {
  const state = await readInternalState();
  return state.pendingPayments[reference] || null;
}

export async function removePendingPayment(reference) {
  await updateInternalState((state) => {
    delete state.pendingPayments[reference];
    return state;
  });
}

function upsertCustomer(state, pendingPayment, purchaseTime) {
  const normalizedEmail = String(pendingPayment.customerEmail || '').trim().toLowerCase();
  const normalizedPhone = String(pendingPayment.customerPhone || '').trim();
  const existingCustomer = state.customers.find((customer) => (
    (normalizedEmail !== '' && String(customer.email || '').trim().toLowerCase() === normalizedEmail)
    || String(customer.phone || '').trim() === normalizedPhone
  ));

  if (existingCustomer) {
    state.customers = state.customers.map((customer) => customer.id === existingCustomer.id ? {
      ...customer,
      name: pendingPayment.customerName,
      email: pendingPayment.customerEmail || customer.email,
      phone: pendingPayment.customerPhone,
      nuit: pendingPayment.customerNUIT || customer.nuit,
      status: 'active',
      totalSpent: customer.totalSpent + pendingPayment.amount,
      transactions: customer.transactions + 1,
      lastPurchaseAt: purchaseTime,
      lastProductName: pendingPayment.productName,
    } : customer);

    return existingCustomer.id;
  }

  const newCustomerId = `cust-${Date.now()}`;
  state.customers = [
    {
      id: newCustomerId,
      name: pendingPayment.customerName,
      email: pendingPayment.customerEmail || undefined,
      phone: pendingPayment.customerPhone,
      nuit: pendingPayment.customerNUIT || undefined,
      status: 'active',
      source: 'checkout',
      totalSpent: pendingPayment.amount,
      transactions: 1,
      createdAt: purchaseTime,
      lastPurchaseAt: purchaseTime,
      lastProductName: pendingPayment.productName,
      notes: 'Cliente criado automaticamente a partir do checkout.',
    },
    ...state.customers,
  ];

  return newCustomerId;
}

function upsertSubscription(state, pendingPayment, customerId, purchaseTime) {
  const product = state.products.find((item) => item.id === pendingPayment.productId);
  if (!product || product.recurrence === 'one-time') {
    return;
  }

  const recurrence = product.recurrence;
  const nextChargeAt = calculateNextChargeDate(purchaseTime, recurrence);
  const existingSubscription = state.subscriptions.find((subscription) => (
    subscription.customerId === customerId
    && subscription.productId === pendingPayment.productId
    && subscription.status !== 'canceled'
  ));

  if (existingSubscription) {
    state.subscriptions = state.subscriptions.map((subscription) => subscription.id === existingSubscription.id ? {
      ...subscription,
      customerName: pendingPayment.customerName,
      amount: pendingPayment.amount,
      recurrence,
      status: 'active',
      source: 'checkout',
      paymentMethod: pendingPayment.paymentMethod,
      lastChargeAt: purchaseTime,
      nextChargeAt,
    } : subscription);
    return;
  }

  state.subscriptions = [
    {
      id: `sub-${Date.now()}`,
      customerId,
      customerName: pendingPayment.customerName,
      productId: pendingPayment.productId,
      productName: pendingPayment.productName,
      amount: pendingPayment.amount,
      recurrence,
      status: 'active',
      source: 'checkout',
      paymentMethod: pendingPayment.paymentMethod,
      startedAt: purchaseTime,
      lastChargeAt: purchaseTime,
      nextChargeAt,
      notes: 'Assinatura criada automaticamente pelo checkout.',
    },
    ...state.subscriptions,
  ];
}

export async function finalizePendingPayment(reference, outcome) {
  const nextState = await updateInternalState((state) => {
    const pendingPayment = state.pendingPayments[reference];

    if (!pendingPayment) {
      return state;
    }

    if (outcome.status === 'success') {
      const purchaseTime = outcome.paidAt || new Date().toISOString();
      const customerId = upsertCustomer(state, pendingPayment, purchaseTime);
      upsertSubscription(state, pendingPayment, customerId, purchaseTime);

      state.logs = [
        {
          id: `${Date.now()}-success`,
          type: 'Pagamento confirmado',
          status: 'success',
          date: formatDateTime(purchaseTime),
          createdAt: purchaseTime,
          transactionId: reference,
          amount: pendingPayment.amount,
          customerName: pendingPayment.customerName,
          customerEmail: pendingPayment.customerEmail || undefined,
          customerPhone: pendingPayment.customerPhone,
          customerNUIT: pendingPayment.customerNUIT || undefined,
          paymentMethod: pendingPayment.paymentMethod,
          productId: pendingPayment.productId,
          productName: pendingPayment.productName,
          providerRef: outcome.providerRef,
          checkoutUrl: pendingPayment.checkoutUrl,
        },
        ...state.logs.map((log) => log.transactionId === reference ? {
          ...log,
          status: 'success',
          providerRef: outcome.providerRef,
        } : log),
      ];
    } else {
      state.logs = state.logs.map((log) => log.transactionId === reference ? {
        ...log,
        status: 'failed',
        providerRef: outcome.providerRef || log.providerRef,
      } : log);
    }

    delete state.pendingPayments[reference];
    return state;
  });

  return nextState;
}

export async function registerCaixa(userData) {
  const name = String(userData?.name || '').trim();
  const login = String(userData?.login || '').trim();
  const email = String(userData?.email || '').trim();
  const password = String(userData?.password || '');
  const caixa = String(userData?.caixa || '').trim();

  if (!name || !login || !email || !password || !caixa) {
    throw new Error('Todos os campos do caixa sao obrigatorios.');
  }

  if (password.length < 6) {
    throw new Error('A senha deve ter pelo menos 6 caracteres.');
  }

  const state = await readInternalState();
  const existingUsers = [...(Array.isArray(state.caixas) ? state.caixas : []), ...(Array.isArray(state.users) ? state.users : [])];

  const normalizedLogin = login.toLowerCase();
  const normalizedEmail = email.toLowerCase();
  const normalizedCaixa = caixa.toLowerCase();

  const exists = existingUsers.some((item) => (
    String(item.login || '').trim().toLowerCase() === normalizedLogin
    || String(item.email || '').trim().toLowerCase() === normalizedEmail
    || String(item.caixa || '').trim().toLowerCase() === normalizedCaixa
  ));

  if (exists) {
    throw new Error('Ja existe um caixa com este login, email ou numero de caixa.');
  }

  const nextUser = {
    id: `caixa-${Date.now()}`,
    name,
    login,
    email,
    password,
    role: 'caixa',
    caixa,
    createdAt: new Date().toISOString(),
  };

  await updateInternalState((currentState) => {
    currentState.caixas = Array.isArray(currentState.caixas) ? [nextUser, ...currentState.caixas] : [nextUser];
    return currentState;
  });

  return {
    ...nextUser,
    password: undefined,
  };
}

export async function getCaixas() {
  const state = await readInternalState();
  return Array.isArray(state.caixas) ? state.caixas : [];
}

export async function findUserByCredentials(identifier, password) {
  const normalizedIdentifier = String(identifier || '').trim().toLowerCase();
  const rawPassword = String(password || '');

  if (!normalizedIdentifier || !rawPassword) {
    return null;
  }

  const state = await readInternalState();
  const candidateUsers = [
    ...(Array.isArray(state.caixas) ? state.caixas : []),
    ...(Array.isArray(state.users) ? state.users : []),
  ];

  return candidateUsers.find((candidate) => {
    const login = String(candidate.login || '').trim().toLowerCase();
    const email = String(candidate.email || '').trim().toLowerCase();
    const candidatePassword = String(candidate.password || '');
    return (login === normalizedIdentifier || email === normalizedIdentifier) && candidatePassword === rawPassword;
  }) || null;
}

































































































































































































































































































































































































































































































































































































