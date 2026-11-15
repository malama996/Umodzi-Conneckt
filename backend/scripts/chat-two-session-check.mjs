/**
 * Two-session chat verification (customer session + technician session).
 * Real HTTP against the running API and the real PostgreSQL rows.
 */
const BASE = 'http://localhost:3001/api/v1';
const CUSTOMER = { email: 'chat-customer-1794760551662@umodzi.test', password: 'LocalTest123!' };
const TECHNICIAN = {
  email: 'dispatch-tech-b-1794569424841@umodzi.test',
  password: 'LocalTest123!',
};
const REQUEST_ID = 'a99fb2bd-06e6-4680-9f55-95937d68b97b';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

// 1-4: both sessions authenticate and reach the same conversation.
const customer = await api('POST', '/auth/login', { body: CUSTOMER });
const technician = await api('POST', '/auth/login', { body: TECHNICIAN });
check('customer session authenticates', customer.status === 200);
check('technician session authenticates', technician.status === 200);
const ct = customer.json?.data?.accessToken;
const tt = technician.json?.data?.accessToken;
check('sessions are distinct', !!ct && !!tt && ct !== tt);

const cConv = await api('GET', `/requests/${REQUEST_ID}/conversation`, { token: ct });
const tConv = await api('GET', `/requests/${REQUEST_ID}/conversation`, { token: tt });
check(
  'both participants resolve the same conversation',
  cConv.status === 200 &&
    tConv.status === 200 &&
    cConv.json?.data?.conversation?.id === tConv.json?.data?.conversation?.id,
  cConv.json?.data?.conversation?.id,
);
const convId = cConv.json?.data?.conversation?.id;

// 5-6: customer sends, technician receives it from the server.
const stamp = new Date().toISOString();
const body = `Customer message ${stamp} — the tap is still dripping after the repair.`;
const sent = await api('POST', `/conversations/${convId}/messages`, {
  token: ct,
  body: { message: body },
});
check('customer message persists', sent.status === 201, `status ${sent.status}`);
const sentId = sent.json?.data?.id;

const techInbox = await api('GET', `/conversations/${convId}/messages?limit=30`, { token: tt });
const techSees = (techInbox.json?.data?.messages ?? []).find((m) => m.id === sentId);
check('technician reads the customer message', !!techSees, techSees?.message?.slice(0, 40));
check(
  'sender identity is server-derived',
  techSees?.senderId === customer.json?.data?.user?.id,
);

// 7-8: technician replies, customer reads it.
const replyBody = `Technician reply ${stamp} — I will bring a new washer this afternoon.`;
const replied = await api('POST', `/conversations/${convId}/messages`, {
  token: tt,
  body: { message: replyBody },
});
check('technician reply persists', replied.status === 201, `status ${replied.status}`);

const custInbox = await api('GET', `/conversations/${convId}/messages?limit=30`, { token: ct });
const custSees = (custInbox.json?.data?.messages ?? []).find((m) => m.id === replied.json?.data?.id);
check('customer reads the reply', !!custSees);

// 9-10: history survives a fresh request (the reload case).
const reloaded = await api('GET', `/conversations/${convId}/messages?limit=30`, { token: ct });
const all = reloaded.json?.data?.messages ?? [];
check(
  'history intact after re-reading',
  all.some((m) => m.id === sentId) && all.some((m) => m.id === replied.json?.data?.id),
  `${all.length} messages`,
);
const ordered = all.every((m, i) => i === 0 || new Date(all[i - 1].createdAt) <= new Date(m.createdAt));
check('messages are in chronological order', ordered);

// 11-14: a failed send is rejected, never accepted as delivered.
const empty = await api('POST', `/conversations/${convId}/messages`, { token: ct, body: { message: '   ' } });
check('empty message rejected', empty.status === 400, `status ${empty.status}`);
const oversized = await api('POST', `/conversations/${convId}/messages`, {
  token: ct,
  body: { message: 'x'.repeat(2001) },
});
check('oversized message rejected', oversized.status === 400, `status ${oversized.status}`);

// 15: unread counts move when the other side reads.
const custNotif = await api('GET', '/me/conversations', { token: ct });
const summary = (custNotif.json?.data?.conversations ?? []).find((c) => c.id === convId);
check('conversation appears in the customer list', !!summary);
const before = summary?.unreadCount ?? 0;
const marked = await api('PATCH', `/conversations/${convId}/read`, { token: ct });
check('mark-read reports a real count', marked.status === 200, JSON.stringify(marked.json?.data));
const afterList = await api('GET', '/me/conversations', { token: ct });
const after = (afterList.json?.data?.conversations ?? []).find((c) => c.id === convId)?.unreadCount;
check('unread count drops after reading', before > 0 && after === 0, `${before} → ${after}`);

// 16: a third authenticated user cannot reach this conversation.
const outsiderEmail = `chat-outsider-${Date.now()}@umodzi.test`;
await api('POST', '/auth/register', {
  body: {
    email: outsiderEmail,
    password: 'LocalTest123!',
    firstName: 'Outside',
    lastName: 'User',
    role: 'customer',
  },
});
const outsider = await api('POST', '/auth/login', {
  body: { email: outsiderEmail, password: 'LocalTest123!' },
});
const ot = outsider.json?.data?.accessToken;
const foreignRead = await api('GET', `/conversations/${convId}/messages`, { token: ot });
const foreignWrite = await api('POST', `/conversations/${convId}/messages`, {
  token: ot,
  body: { message: 'I should not be able to post here.' },
});
check('outsider cannot read the conversation', foreignRead.status === 404, `status ${foreignRead.status}`);
check('outsider cannot post to it', foreignWrite.status === 404, `status ${foreignWrite.status}`);
const anon = await api('GET', `/conversations/${convId}/messages`);
check('unauthenticated read is refused', anon.status === 401, `status ${anon.status}`);

// Admin must not gain default access to private conversations.
const admin = await api('POST', '/auth/login', {
  body: { email: 'admin@umodzi.test', password: 'LocalTestAdmin2026!' },
});
const adminRead = await api('GET', `/conversations/${convId}/messages`, {
  token: admin.json?.data?.accessToken,
});
check('administrator is not a silent participant', adminRead.status === 404, `status ${adminRead.status}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
