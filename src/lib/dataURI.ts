export function dataURItoUint8Array(dataURI: string) {
  // convert base64/URLEncoded data component to raw binary data held in a string
  let byteString = "";
  if (dataURI.split(",")[0].indexOf("base64") >= 0)
    byteString = atob(dataURI.split(",")[1]);
  else byteString = decodeURIComponent(dataURI.split(",")[1]);

  // write the bytes of the string to a typed array
  const array = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    array[i] = byteString.charCodeAt(i);
  }

  // SECURITY: never trust the MIME declared in the data URI. Determine the type
  // from the actual file signature (magic bytes); reject anything that is not a
  // recognized image so a client cannot smuggle, e.g., HTML/SVG as "image/png".
  const mimeString = sniffImageMime(array);
  if (!mimeString) {
    throw new Error(
      "Unsupported image: file signature is not a recognized image type",
    );
  }

  return {
    data: array,
    mime: mimeString,
  };
}

// Recognizes raster image types by their leading bytes. Returns the canonical
// MIME string, or null if the bytes are not a supported image.
function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
