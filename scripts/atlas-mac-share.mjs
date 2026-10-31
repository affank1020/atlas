import { createConnection } from 'node:net';
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
export async function shareFromMacClipboard() {
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
    const choices = recipients.filter(recipient => recipient &&
        (recipient.available === true || recipient.queueAvailable === true) &&
        typeof recipient.nodeId === 'string' && typeof recipient.name === 'string');
    if (!choices.length) {
        console.log('No approved receiving devices can accept live or queued shares.');
        return;
    }
    console.log('Share clipboard text (' + text.length + ' characters) to an approved Atlas Node:');
    choices.forEach((item, i) => console.log(formatShareRecipientOption(item, i) +
        (item.available === true ? ' · online (Copy confirmation)' : ' · offline (queue for later)')));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question('Choose device number (Enter to cancel): ')).trim();
        if (!/^[1-9]\d*$/.test(answer)) { console.log('Cancelled.'); return; }
        const index = Number(answer) - 1;
        if (!Number.isSafeInteger(index) || index >= choices.length) {
            console.log('Cancelled.'); return;
        }
        const target = choices[index];
        console.log(target.available === true
            ? 'Confirm Send in the native Atlas dialog on your Mac.'
            : 'This will be ENCRYPTED and QUEUED for up to 24 hours, NOT copied now. Confirm in the native Atlas dialog.');
        const receipt = await localRequest({
            action: target.available === true ? 'send' : 'queue',
            targetNodeId: target.nodeId, text,
        });
        if (!receipt.ok) {
            throw Error('Atlas did not confirm delivery (' + (receipt.code || 'SHARE_UNAVAILABLE') +
                '). If interrupted, do not resend until checking the target.');
        }
        if (receipt.result?.cancelled === true)
            console.log('Cancelled on Mac; nothing sent.');
        else if (receipt.result?.state === 'queued')
            console.log('Queued on Atlas until ' + receipt.result.expiresAt + '. NOT yet copied to the device.');
        else if (['copied', 'declined', 'expired'].includes(receipt.result?.state))
            console.log('Prior queued delivery status: ' + receipt.result.state + '.');
        else if (receipt.result?.accepted === true)
            console.log('Accepted. The receiving device confirmed the copy.');
        else if (receipt.result?.accepted === false)
            console.log('The receiving device declined the share.');
        else throw Error('Delivery status unconfirmed. Do not automatically retry.');
    } finally {
        rl.close();
        text = ''; // best effort: no persistent local queue or drafts.
    }
}
