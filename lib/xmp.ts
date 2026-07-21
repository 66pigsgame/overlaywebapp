function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Iptc4xmpCore:AltTextAccessibility is the standard "Alt Text" field social
// platforms and accessibility tools read from image metadata. dc:description
// is included too for broader compatibility (e.g. macOS Finder/Preview).
export function buildAltTextXmp(altText: string): string {
  const escaped = escapeXml(altText);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
      xmlns:dc="http://purl.org/dc/elements/1.1/">
      <Iptc4xmpCore:AltTextAccessibility>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escaped}</rdf:li>
        </rdf:Alt>
      </Iptc4xmpCore:AltTextAccessibility>
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escaped}</rdf:li>
        </rdf:Alt>
      </dc:description>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
