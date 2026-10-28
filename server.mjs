import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import {
  finalizePendingPayment,
  findUserByCredentials,
  getCaixas,
  getPendingPayment,
  getProviderConfig,
  getPublicState,
  getStorageDriver,
  readInternalState,
  recordPendingPayment,
  registerCaixa,
  replaceResource,
  savePaymentConfig,
  updateInternalState,
} from './server-store.mjs';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_API_URL = 'https://paysuite.tech/api/v1';
const SUCCESS_STATUSES = new Set(['success', 'successful', 'paid', 'completed', 'complete']);
const FAILED_STATUSES = new Set(['failed', 'canceled', 'cancelled', 'expired']);
const RESOURCE_MAP = new Set(['products', 'apps', 'customers', 'subscriptions', 'config', 'logs']);
const DIST_DIR = path.resolve(process.cwd(), 'dist');
const AUTH_SECRET = String(process.env.AUTH_SECRET || 'dr-gestor-auth-secret').trim() || 'dr-gestor-auth-secret';
const ADMIN_LOGIN = String(process.env.ADMIN_LOGIN || 'admin').trim().toLowerCase();
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@drgestor.local').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'Admin@12345');
const ADMIN_NAME = String(process.env.ADMIN_NAME || 'Admin Master').trim() || 'Admin Master';
const AUTH_SESSION_HOURS = Math.max(Number(process.env.AUTH_SESSION_HOURS || 12) || 12, 1);

app.use(express.json({
  limit: '1mb',
  verify: (request, _response, buffer) => {
    request.rawBody = buffer.toString('utf8');
  },
}));

app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  response.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }

  next();
});

function getAdminProfile() {
  return {
    login: ADMIN_LOGIN,
    email: ADMIN_EMAIL,
    name: ADMIN_NAME,
    role: 'admin',
  };
}

function normalizeLoginKey(value) {
  return String(value || '').trim().toLowerCase();
}

function encodeBase64Url(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function decodeBase64Url(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function signAuthPayload(encodedPayload) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(encodedPayload).digest('base64url');
}

function buildUserProfile(user) {
  const role = String(user?.role || 'caixa').toLowerCase();
  return {
    id: user?.id || user?.login || 'user',
    login: String(user?.login || '').trim(),
    email: String(user?.email || '').trim(),
    name: String(user?.name || user?.login || 'Usuário').trim(),
    role,
    caixa: user?.caixa || null,
  };
}

function createAuthTokenForUser(user) {
  const payload = {
    ...buildUserProfile(user),
    exp: Date.now() + (AUTH_SESSION_HOURS * 60 * 60 * 1000),
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signAuthPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseAuthToken(token) {
  const [encodedPayload, providedSignature] = String(token || '').split('.');
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signAuthPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(providedSignature, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    if (!payload || Number(payload.exp || 0) < Date.now()) {
      return null;
    }

    return buildUserProfile(payload);
  } catch {
    return null;
  }
}

function readBearerToken(request) {
  const header = String(request.get('authorization') || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) {
    return '';
  }

  return header.slice(7).trim();
}

function requireAuth(request, response, next, allowedRoles = ['admin', 'caixa']) {
  const user = parseAuthToken(readBearerToken(request));
  if (!user) {
    response.status(401).json({ status: 'error', message: 'Sessao invalida ou expirada.' });
    return;
  }

  const role = String(user.role || '').toLowerCase();
  if (!allowedRoles.map((item) => item.toLowerCase()).includes(role)) {
    response.status(403).json({ status: 'error', message: 'Sem permissao para acessar este recurso.' });
    return;
  }

  request.user = user;
  next();
}

function requireAdminAuth(request, response, next) {
  return requireAuth(request, response, next, ['admin']);
}

function resolveApiBaseUrl(environmentHeader) {
  if (String(environmentHeader || '').toLowerCase() === 'sandbox') {
    return process.env.PAYSUITE_SANDBOX_API_URL || process.env.PAYSUITE_API_URL || DEFAULT_API_URL;
  }

  return process.env.PAYSUITE_API_URL || DEFAULT_API_URL;
}

function isValidAbsoluteUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readProviderPayload(providerResponse) {
  const rawBody = await providerResponse.text();

  if (!rawBody) {
    return {
      status: providerResponse.ok ? 'success' : 'error',
      message: providerResponse.ok ? undefined : 'A PaySuite devolveu uma resposta vazia.',
      data: undefined,
    };
  }

  try {
    const parsed = JSON.parse(rawBody);
    return {
      status: parsed.status || (providerResponse.ok ? 'success' : 'error'),
      message: parsed.message,
      data: parsed.data,
    };
  } catch {
    return {
      status: providerResponse.ok ? 'success' : 'error',
      message: rawBody,
      data: undefined,
    };
  }
}

async function callPaySuite({ method, path: endpointPath, token, environment, body }) {
  const apiBaseUrl = resolveApiBaseUrl(environment);
  const providerResponse = await fetch(`${apiBaseUrl}/${endpointPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await readProviderPayload(providerResponse);

  return {
    providerResponse,
    payload,
    apiBaseUrl,
  };
}

async function getEffectiveProviderConfig(overrides = {}) {
  const savedConfig = await getProviderConfig();
  const apiKey = String(overrides.apiKey || savedConfig.apiKey || '').trim();
  const environment = String(overrides.environment || savedConfig.environment || 'Producao').trim();
  const webhookSecret = String(overrides.webhookSecret || savedConfig.webhookSecret || '').trim();

  return {
    apiKey,
    environment,
    webhookSecret,
    generatedWebhook: String(savedConfig.generatedWebhook || '').trim(),
  };
}

async function confirmPaymentByReference(reference) {
  const pendingPayment = await getPendingPayment(reference);

  if (!pendingPayment) {
    return {
      ok: false,
      code: 404,
      status: 'error',
      message: 'Referencia PaySuite nao encontrada ou ja processada.',
    };
  }

  const providerConfig = await getEffectiveProviderConfig();
  if (!providerConfig.apiKey) {
    return {
      ok: false,
      code: 400,
      status: 'error',
      message: 'As credenciais PaySuite nao estao guardadas no servidor.',
    };
  }

  const { providerResponse, payload } = await callPaySuite({
    method: 'GET',
    path: `payments/${pendingPayment.paymentId}`,
    token: providerConfig.apiKey,
    environment: providerConfig.environment,
  });

  if (!providerResponse.ok || payload.status !== 'success') {
    return {
      ok: false,
      code: providerResponse.status || 502,
      status: 'error',
      message: payload.message || 'Nao foi possivel confirmar o pagamento na PaySuite.',
    };
  }

  const paymentData = payload.data || {};
  const providerStatus = String(paymentData.status || paymentData.transaction?.status || '').toLowerCase();
  const providerRef = String(paymentData.transaction?.transaction_id || paymentData.transaction?.id || paymentData.id || reference);
  const isApproved = Boolean(paymentData.transaction) || SUCCESS_STATUSES.has(providerStatus);
  const isRejected = FAILED_STATUSES.has(providerStatus);

  if (isApproved) {
    const paidAt = paymentData.transaction?.paid_at || new Date().toISOString();
    await finalizePendingPayment(reference, {
      status: 'success',
      providerRef,
      paidAt,
    });

    return {
      ok: true,
      code: 200,
      status: 'success',
      message: 'Pagamento confirmado com sucesso.',
      data: {
        reference,
        providerRef,
        paidAt,
        status: providerStatus || 'success',
      },
    };
  }

  if (isRejected) {
    await finalizePendingPayment(reference, {
      status: 'failed',
      providerRef,
    });

    return {
      ok: true,
      code: 200,
      status: 'failed',
      message: 'A PaySuite marcou este pedido como nao pago.',
      data: {
        reference,
        providerRef,
        status: providerStatus || 'failed',
      },
    };
  }

  return {
    ok: true,
    code: 200,
    status: 'pending',
    message: 'O pedido ainda esta pendente na PaySuite.',
    data: {
      reference,
      providerRef,
      status: providerStatus || 'pending',
    },
  };
}

app.get('/api/health', (_request, response) => {
  response.json({
    status: 'success',
    message: 'Servidor local pronto.',
    storage: getStorageDriver(),
    auth: 'enabled',
  });
});

app.post('/api/auth/login', async (request, response) => {
  const identifier = normalizeLoginKey(request.body?.identifier || '');
  const password = String(request.body?.password || '');

  if (!identifier || !password) {
    response.status(400).json({ status: 'error', message: 'Informe o login e a senha.' });
    return;
  }

  const adminUser = (identifier === ADMIN_LOGIN || identifier === ADMIN_EMAIL)
    && password === ADMIN_PASSWORD
    ? getAdminProfile()
    : null;

  const registeredUser = adminUser || await findUserByCredentials(identifier, password);

  if (!registeredUser) {
    response.status(401).json({ status: 'error', message: 'Credenciais invalidas.' });
    return;
  }

  response.json({
    status: 'success',
    token: createAuthTokenForUser(registeredUser),
    user: registeredUser,
  });
});

app.post('/api/auth/register', async (request, response) => {
  try {
    const payload = {
      name: String(request.body?.name || '').trim(),
      login: String(request.body?.login || '').trim(),
      email: String(request.body?.email || '').trim(),
      password: String(request.body?.password || ''),
      caixa: String(request.body?.caixa || '').trim(),
    };

    if (!payload.name || !payload.login || !payload.email || !payload.password || !payload.caixa) {
      response.status(400).json({ status: 'error', message: 'Preencha nome, login, email, senha e numero do caixa.' });
      return;
    }

    const user = await registerCaixa(payload);
    response.status(201).json({
      status: 'success',
      message: 'Caixa cadastrado com sucesso.',
      user,
    });
  } catch (error) {
    response.status(400).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Nao foi possivel cadastrar o caixa.',
    });
  }
});

app.get('/api/auth/session', requireAuth, (request, response) => {
  response.json({
    status: 'success',
    user: request.user,
  });
});

app.post('/api/auth/logout', (_request, response) => {
  response.json({ status: 'success' });
});

app.get('/api/caixas', requireAuth, async (_request, response) => {
  response.json({
    status: 'success',
    caixas: await getCaixas(),
  });
});

app.get('/api/public-store', async (_request, response) => {
  const state = await getPublicState();
  response.json({
    products: state.products,
    apps: state.apps,
    config: state.config,
    paymentConfig: state.paymentConfig,
  });
});

app.get('/api/store', requireAdminAuth, async (_request, response) => {
  response.json(await getPublicState());
});

app.put('/api/store/:resource', requireAdminAuth, async (request, response) => {
  const resource = String(request.params.resource || '').trim();
  if (!RESOURCE_MAP.has(resource)) {
    response.status(404).json({ status: 'error', message: 'Recurso invalido.' });
    return;
  }

  try {
    const publicState = await replaceResource(resource, request.body?.value);
    response.json({
      status: 'success',
      resource,
      state: publicState,
    });
  } catch (error) {
    response.status(400).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Nao foi possivel guardar os dados.',
    });
  }
});

app.post('/api/admin/payment-config', requireAdminAuth, async (request, response) => {
  const apiKey = String(request.body?.apiKey || '').trim();
  const webhookSecret = String(request.body?.webhookSecret || '').trim();
  const environment = String(request.body?.environment || 'Producao').trim();
  const generatedWebhook = String(request.body?.generatedWebhook || '').trim();

  if (!apiKey) {
    response.status(400).json({ status: 'error', message: 'O token PaySuite e obrigatorio.' });
    return;
  }

  const paymentConfig = await savePaymentConfig({
    apiKey,
    webhookSecret,
    environment,
    generatedWebhook,
  });

  response.json({ status: 'success', paymentConfig });
});

app.post('/api/paysuite/test-connection', requireAdminAuth, async (request, response) => {
  try {
    const providerConfig = await getEffectiveProviderConfig({
      apiKey: request.body?.apiKey,
      environment: request.body?.environment,
      webhookSecret: request.body?.webhookSecret,
    });

    if (!providerConfig.apiKey) {
      response.status(400).json({
        status: 'error',
        message: 'Guarde primeiro o token PaySuite ou informe um token para testar.',
      });
      return;
    }

    const testId = '00000000-0000-4000-8000-000000000000';
    const { providerResponse } = await callPaySuite({
      method: 'GET',
      path: `payments/${testId}`,
      token: providerConfig.apiKey,
      environment: providerConfig.environment,
    });

    if (providerResponse.status === 401 || providerResponse.status === 403) {
      response.status(401).json({
        status: 'error',
        message: 'A PaySuite recusou o token informado.',
      });
      return;
    }

    response.json({
      status: 'success',
      message: 'Conexao com a API PaySuite respondendo normalmente.',
      providerStatus: providerResponse.status,
    });
  } catch (error) {
    response.status(502).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Falha ao contactar a PaySuite.',
    });
  }
});

app.post('/api/paysuite/payments', async (request, response) => {
  const amount = Number(request.body?.amount || 0);
  const reference = String(request.body?.reference || '').trim();
  const description = String(request.body?.description || '').trim();
  const returnUrl = String(request.body?.returnUrl || '').trim();
  const callbackUrl = String(request.body?.callbackUrl || '').trim();
  const productId = String(request.body?.productId || '').trim();
  const productName = String(request.body?.productName || '').trim();
  const customerName = String(request.body?.customerName || '').trim();
  const customerEmail = String(request.body?.customerEmail || '').trim();
  const customerPhone = String(request.body?.customerPhone || '').trim();
  const customerNUIT = String(request.body?.customerNUIT || '').trim();
  const paymentMethod = request.body?.paymentMethod === 'emola' ? 'emola' : 'mpesa';
  const appId = String(request.body?.appId || '').trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    response.status(400).json({ status: 'error', message: 'Valor invalido para a cobranca.' });
    return;
  }

  if (!reference || !description || !productId || !productName || !customerName || !customerPhone) {
    response.status(400).json({ status: 'error', message: 'Os dados da cobranca estao incompletos.' });
    return;
  }

  if (!isValidAbsoluteUrl(returnUrl)) {
    response.status(400).json({ status: 'error', message: 'URL de retorno invalida.' });
    return;
  }

  const providerConfig = await getEffectiveProviderConfig();
  if (!providerConfig.apiKey) {
    response.status(400).json({ status: 'error', message: 'A PaySuite ainda nao foi configurada no servidor.' });
    return;
  }

  const providerBody = {
    amount: amount.toFixed(2),
    reference,
    description,
    return_url: returnUrl,
    ...(isValidAbsoluteUrl(callbackUrl || providerConfig.generatedWebhook) ? { callback_url: callbackUrl || providerConfig.generatedWebhook } : {}),
  };

  try {
    const { providerResponse, payload } = await callPaySuite({
      method: 'POST',
      path: 'payments',
      token: providerConfig.apiKey,
      environment: providerConfig.environment,
      body: providerBody,
    });

    if (!providerResponse.ok || payload.status !== 'success') {
      response.status(providerResponse.status || 502).json({
        status: payload.status || 'error',
        message: payload.message || 'Falha ao criar o pedido na PaySuite.',
      });
      return;
    }

    const paymentId = String(payload.data?.id || '').trim();
    const checkoutUrl = String(payload.data?.checkout_url || '').trim();

    if (!paymentId || !checkoutUrl) {
      response.status(502).json({
        status: 'error',
        message: 'A PaySuite nao devolveu o link de checkout.',
      });
      return;
    }

    await recordPendingPayment({
      reference,
      paymentId,
      transactionId: reference,
      productId,
      productName,
      amount,
      customerName,
      customerEmail: customerEmail || undefined,
      customerPhone,
      customerNUIT: customerNUIT || undefined,
      paymentMethod,
      appId: appId || undefined,
      checkoutUrl,
      returnUrl,
      createdAt: new Date().toISOString(),
    });

    response.json({
      status: 'success',
      data: {
        id: paymentId,
        reference,
        checkout_url: checkoutUrl,
        amount: amount.toFixed(2),
      },
    });
  } catch (error) {
    response.status(502).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Falha ao criar o pedido na PaySuite.',
    });
  }
});

app.get('/api/paysuite/confirm/:reference', async (request, response) => {
  try {
    const result = await confirmPaymentByReference(String(request.params.reference || '').trim());
    response.status(result.code).json(result);
  } catch (error) {
    response.status(502).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Falha ao confirmar o pagamento.',
    });
  }
});

app.post('/api/paysuite/webhook', async (request, response) => {
  const providerConfig = await getEffectiveProviderConfig();
  const signature = String(request.get('x-paysuite-signature') || '').trim();
  const rawBody = String(request.rawBody || '');

  if (providerConfig.webhookSecret) {
    const expectedSignature = crypto
      .createHmac('sha256', providerConfig.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      response.status(401).json({ status: 'error', message: 'Assinatura do webhook invalida.' });
      return;
    }
  }

  const event = String(request.body?.event || '').trim();
  const data = request.body?.data || {};
  const reference = String(data.reference || '').trim();
  const paymentStatus = String(data.status || data.transaction?.status || '').toLowerCase();
  const providerRef = String(data.transaction?.transaction_id || data.transaction?.id || data.id || reference).trim();

  if (reference && SUCCESS_STATUSES.has(paymentStatus)) {
    await finalizePendingPayment(reference, {
      status: 'success',
      providerRef,
      paidAt: data.transaction?.paid_at || new Date().toISOString(),
    });
  } else if (reference && FAILED_STATUSES.has(paymentStatus)) {
    await finalizePendingPayment(reference, {
      status: 'failed',
      providerRef,
    });
  }

  response.json({
    status: 'success',
    event,
    paymentStatus,
    approved: SUCCESS_STATUSES.has(paymentStatus),
    failed: FAILED_STATUSES.has(paymentStatus),
  });
});

app.get('/api/debug/internal-store', requireAdminAuth, async (_request, response) => {
  response.json(await readInternalState());
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^\/(?!api).*/, (_request, response) => {
    response.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`PaySuite local API ready on http://127.0.0.1:${PORT}`);
});































































































































