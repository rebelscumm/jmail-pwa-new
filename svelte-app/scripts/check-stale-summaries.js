#!/usr/bin/env node
const { openDB } = require('idb');

async function main() {
  const db = await openDB('gmail-pwa-db', 2);
  const all = await db.getAll('threads');
  const stale = all.filter(t => t && t.summary && String(t.summary).trim() && t.summaryStatus === 'pending');
  if (!stale.length) {
    console.log('No stale summary pending markers found.');
    process.exit(0);
  }
  console.log('Found', stale.length, 'threads with cached summary but pending status:');
  for (const s of stale.slice(0, 50)) console.log('-', s.threadId || '(no id)');
  console.log('\nTo fix them, run the script with --fix');
  if (process.argv.includes('--fix')) {
    const tx = db.transaction('threads', 'readwrite');
    let updated = 0;
    for (const t of stale) {
      try {
        const next = { ...t, summaryStatus: 'ready', summaryPendingAt: undefined };
        await tx.store.put(next);
        updated++;
      } catch (e) { console.error('Failed to update', t.threadId, e); }
    }
    await tx.done;
    console.log('Updated', updated, 'threads');
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(2); });


