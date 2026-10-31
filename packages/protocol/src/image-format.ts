/** Common metadata-only image format and decompression-size bounds.
 * Never decode an untrusted 8 MiB input at native resolution without
 * validating its declared dimensions first. Accept cropped images of any
 * valid aspect ratio, not only full screenshots.
 */
export const MAX_IMAGE_PIXELS = 36_000_000;
export const MAX_IMAGE_EDGE = 16_384;

export function imageDimensions(bytes: Uint8Array, mime: string):
    { width: number; height: number } | null {
    if (bytes.length < 24 || bytes.length > 8 * 1024 * 1024) return null;
    const u8 = (i: number) => bytes[i] ?? 0;
    const u16 = (i: number) => u8(i) * 256 + u8(i + 1);
    const valid = (width: number, height: number) =>
        Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
        width >= 1 && height >= 1 && width <= MAX_IMAGE_EDGE &&
        height <= MAX_IMAGE_EDGE && width * height <= MAX_IMAGE_PIXELS;
    if (mime === 'image/png') {
        if (![137,80,78,71,13,10,26,10].every((x,i)=>u8(i)===x) ||
            u8(12)!==73 || u8(13)!==72 || u8(14)!==68 || u8(15)!==82)
            return null;
        const width=u8(16)*0x1000000+u8(17)*65536+u8(18)*256+u8(19);
        const height=u8(20)*0x1000000+u8(21)*65536+u8(22)*256+u8(23);
        return valid(width,height)?{width,height}:null;
    }
    if (mime !== 'image/jpeg' || u8(0)!==255 || u8(1)!==216 ||
        u8(bytes.length-2)!==255 || u8(bytes.length-1)!==217) return null;
    // Find a JPEG start-of-frame marker without allocating a bitmap. Reject
    // malformed marker lengths and limit scanning to the original byte cap.
    let p=2;
    while(p+3<bytes.length) {
        if(u8(p++)!==255) return null;
        while(p<bytes.length && u8(p)===255) p++;
        const marker=u8(p++);
        if(marker===0xda || marker===0xd9) return null;
        if(marker===0x01 || (marker>=0xd0 && marker<=0xd7)) continue;
        if(p+2>bytes.length) return null;
        const length=u16(p);
        if(length<2 || p+length>bytes.length) return null;
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
            if(length<7) return null;
            const height=u16(p+3),width=u16(p+5);
            return valid(width,height)?{width,height}:null;
        }
        p+=length;
    }
    return null;
}
