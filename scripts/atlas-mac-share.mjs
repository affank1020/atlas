import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const socketPath = () => join(homedir(), 'Library', 'Application Support', 'Atlas', 'node-share.sock');
const MAX_REQUEST = 80 * 1024;
const MAX_RESULT = 16 * 1024;

/**
 * Node names and platforms are receiver-controlled metadata. Render them as
 * inert text: strip ASCII/C1 terminal control bytes (including ESC, CSI, OSC,
 * CR/LF and backspace), Unicode line separators, and bidi override controls.
 * Keep normal non-ASCII letters and emoji intact.
 */
export function safeTerminalLabel(value) {
    return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
}

export function formatShareRecipientOption(recipient, index) {
    return '  ' + (index + 1) + '. ' + safeTerminalLabel(recipient.name) +
        ' (' + safeTerminalLabel(recipient.platform) + ')';
}

function checkSocket(path) {
    const parent = lstatSync(dirname(path));
    const entry = lstatSync(path);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 ||
        parent.uid !== process.getuid() || !entry.isSocket() ||
        entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
        throw Error('Mac Node share socket is not private to this user.');
    }
}
async function localRequest(request, path = socketPath()) {
    checkSocket(path);
    const packet = Buffer.from(JSON.stringify(request) + '\n', 'utf8');
    if (packet.length > MAX_REQUEST) throw Error('Share is too large.');
    return new Promise((resolve, reject) => {
        const socket = createConnection(path);
        let result = Buffer.alloc(0), done = false;
        const fail = message => { if (done) return; done = true; socket.destroy(); reject(Error(message)); };
        socket.setTimeout(58_000, () => fail('Share result unconfirmed; do not retry automatically.'));
        socket.once('error', () => fail('Mac Node sharing socket unavailable.'));
        socket.on('data', chunk => {
            if (done) return;
            result = Buffer.concat([result, chunk]);
            if (result.length > MAX_RESULT) return fail('Invalid local sharing response.');
            const end = result.indexOf(10);
            if (end < 0) return;
            done = true; socket.end();
            try {
                const response = JSON.parse(result.subarray(0, end).toString('utf8'));
                if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean')
                    throw Error('Malformed response');
                resolve(response);
            } catch { reject(Error('Invalid local sharing response.')); }
        });
        socket.once('close', () => { if (!done) fail('Share result unconfirmed; do not retry automatically.'); });
        socket.once('connect', () => socket.write(packet));
    });
}

/**
 * Explicit local CLI action: never accept share text on argv, persist a draft,
 * start a second Node identity/socket, or print clipboard content.
 */
export async function shareFromMacClipboard(mode = 'live') {
    if (mode !== 'live' && mode !== 'queue') throw Error('Invalid share mode.');
    if (process.platform !== 'darwin' || !process.stdin.isTTY || !process.stdout.isTTY)
        throw Error('Run ./atlasctl share interactively in the logged-in Mac Terminal.');
    let text;
    try {
        // Never put the clipboard in a command argument/environment or output.
        text = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8', maxBuffer: MAX_REQUEST });
    } catch { throw Error('Could not read plain text from Mac clipboard.'); }
    if (!text || text.trim().length === 0 || text.length > 16_384)
        throw Error('Clipboard must contain 1–16,384 non-blank text characters.');
    const directory = await localRequest({ action: 'recipients' });
    if (directory.ok !== true) {
        throw Error('Approved devices could not be loaded (' + (directory.code || 'SHARE_UNAVAILABLE') + ').');
    }
    const recipients = directory.result?.recipients;
    if (!Array.isArray(recipients)) throw Error('Unexpected recipient list.');
    const ready = recipients.filter(recipient => recipient &&
        (mode === 'queue' || recipient.available === true) &&
        typeof recipient.nodeId === 'string' && typeof recipient.name === 'string');
    if (!ready.length) {
        console.log(mode === 'queue' ? 'No approved recipients. Check sharing approvals in Atlas Web → Nodes.'
            : 'No approved receiving devices are online. Check Mac → Android approval in Atlas Web → Nodes.');
        return;
    }
    console.log((mode === 'queue' ? 'Queue' : 'Share') + ' clipboard text (' + text.length +
        ' characters) to an approved Atlas Node:');
    ready.forEach((item, i) => console.log(formatShareRecipientOption(item, i)));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question('Choose device number (Enter to cancel): ')).trim();
        if (!/^[1-9]\d*$/.test(answer)) { console.log('Cancelled.'); return; }
        const index = Number(answer) - 1;
        if (!Number.isSafeInteger(index) || index >= ready.length) {
            console.log('Cancelled.'); return;
        }
        const target = ready[index];
        console.log('Confirm ' + (mode === 'queue' ? 'Queue' : 'Send') + ' in the native Atlas dialog on your Mac.');
        const deliveryId = mode === 'queue' ? randomUUID() : undefined;
        const receipt = await localRequest(mode === 'queue'
            ? { action: 'queue', targetNodeId: target.nodeId, text, deliveryId }
            : { action: 'send', targetNodeId: target.nodeId, text });
        if (!receipt.ok) {
            throw Error('Atlas did not confirm delivery (' + (receipt.code || 'SHARE_UNAVAILABLE') +
                '). If interrupted, do not resend until checking the target.');
        }
        if (receipt.result?.cancelled === true)
            console.log('Cancelled on Mac; nothing sent.');
        else if (mode === 'queue' && receipt.result?.deliveryId === deliveryId &&
            receipt.result?.status === 'queued') {
            console.log('Queued on Atlas Server for up to 24 hours. Not copied on the receiving device.');
            console.log('Delivery ID: ' + deliveryId + '. If confirmation was interrupted, check this ID before retrying.');
        } else if (mode === 'queue' && receipt.result?.deliveryId === deliveryId &&
            ['expired','declined','user_copied'].includes(receipt.result?.status)) {
            console.log('Server reports delivery ' + deliveryId + ' as ' + receipt.result.status +
                '; this operation did not confirm a new clipboard write.');
        } else if (receipt.result?.accepted === true)
            console.log('Accepted. The receiving device confirmed the copy.');
        else if (receipt.result?.accepted === false)
            console.log('The receiving device declined the share.');
        else throw Error('Delivery status unconfirmed. Do not automatically retry.');
    } finally {
        rl.close();
        text = ''; // best effort: no persistent local queue or drafts.
    }
}
