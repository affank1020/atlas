import { z } from 'zod';

/**
 * Proposal for a transport-independent, explicitly authorised device-sharing
 * channel. No gateway currently accepts these messages, by design.
 */
export const MAX_DEVICE_SHARE_TEXT = 16_384;
export const deviceShareTextSchema = z.string().min(1).max(MAX_DEVICE_SHARE_TEXT);

/** Node -> Server: target only; the server derives the source from its authenticated socket. */
export const deviceShareSubmissionSchema = z.object({
    type: z.literal('device.share.submit'),
    requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    targetNodeId: z.string().uuid(),
    text: deviceShareTextSchema,
}).strict();

/** A registered sender requests only its approved targets. No source ID supplied by client. */
export const deviceShareRecipientsRequestSchema = z.object({
    type: z.literal('device.share.recipients'),
    requestId: z.string().uuid(),
}).strict();
export const deviceShareRecipientSchema = z.object({
    nodeId: z.string().uuid(), name: z.string().min(1).max(200),
    platform: z.string().min(1).max(80),
    status: z.enum(['online', 'offline', 'unavailable']),
    available: z.boolean(),
}).strict();
export const deviceShareRecipientsResultSchema = z.object({
    recipients: z.array(deviceShareRecipientSchema).max(64),
}).strict();

/**
 * Explicit opt-in queue directory. Never add fields to the legacy
 * device.share.recipients response: Android 0.6 and earlier Mac Nodes use
 * exact five-field parsing and may disconnect on unknown properties.
 */
export const deviceInboxRecipientsRequestSchema = z.object({
    type: z.literal('device.inbox.recipients'),
    requestId: z.string().uuid(),
}).strict();
export const deviceInboxRecipientSchema = deviceShareRecipientSchema.extend({
    queueCapable: z.boolean(),
}).strict();
export const deviceInboxRecipientsResultSchema = z.object({
    recipients: z.array(deviceInboxRecipientSchema).max(64),
}).strict();

/** Server -> Target Node: the server sets source and expiry only after authorisation. */
export const deviceShareDeliverySchema = z.object({
    type: z.literal('request'),
    kind: z.literal('device_share'),
    requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    sourceNodeId: z.string().uuid(),
    text: deviceShareTextSchema,
    expiresAt: z.iso.datetime({ offset: true }),
}).strict();

/** A receiving Node must explicitly accept; queueing alone is not delivery. */
export const deviceShareReceiptSchema = z.object({
    accepted: z.boolean(),
}).strict();

export type DeviceShareSubmission = z.infer<typeof deviceShareSubmissionSchema>;
export type DeviceShareDelivery = z.infer<typeof deviceShareDeliverySchema>;
export type DeviceShareReceipt = z.infer<typeof deviceShareReceiptSchema>;

/** Separately requested offline queue: never change live share.submit receipt semantics. */
export const deviceInboxEnqueueSchema = z.object({
    type: z.literal('device.inbox.enqueue'),
    requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    targetNodeId: z.string().uuid(),
    text: deviceShareTextSchema,
}).strict();
export const deviceInboxListSchema = z.object({
    type: z.literal('device.inbox.list'), requestId: z.string().uuid(),
}).strict();
export const deviceInboxReadSchema = z.object({
    type: z.literal('device.inbox.read'), requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
}).strict();
export const deviceInboxDecideSchema = z.object({
    type: z.literal('device.inbox.decide'), requestId: z.string().uuid(),
    deliveryId: z.string().uuid(), decision: z.enum(['user_copied','declined']),
}).strict();

