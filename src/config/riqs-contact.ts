// Verified against https://rwandaiqs.org/contact-us/ on 2026-10-03.
// The contact page/footer provide the primary phone; the header lists alternatives.
// Kept in both apps because the frontend and backend are deployed independently.
export const RIQS_CONTACT = {
  email: "qsrwanda@gmail.com",
  phone: "+250781909076",
  phoneDisplay: "+250 781 909 076",
  additionalPhones: [
    { number: "+250788302519", display: "+250 788 302 519" },
    { number: "+250783772116", display: "+250 783 772 116" },
  ],
  building: "Business Heights Center (BHC) Building",
  streetAddress: "332R+2VH, KG 7 Ave 5, Kigali, Rwanda",
  address: "Business Heights Center (BHC) Building, 332R+2VH, KG 7 Ave 5, Kigali, Rwanda",
  mapsUrl: "https://maps.app.goo.gl/r7bgYiNoVEJwQvwD6",
  website: "https://rwandaiqs.org",
  websiteDisplay: "rwandaiqs.org",
  openingHours: "Monday–Friday, 09:00–17:00",
  weekendHours: "Saturday & Sunday: Closed",
} as const;

// Preserve saved template wording while correcting the old Secretariat addresses.
export function normalizeRiqsContactEmail(body: string): string {
  return body.replace(/(^|[^\w.+-])(?:info|secretariat)@riqs\.rw(?![\w.-])/gi, (_, prefix: string) => `${prefix}${RIQS_CONTACT.email}`);
}
