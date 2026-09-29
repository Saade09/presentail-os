import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/content"];

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function getServiceAccountCredentials() {
  const encoded = requiredEnv("GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  const json = Buffer.from(encoded, "base64").toString("utf8");
  return JSON.parse(json);
}

async function getAccessToken() {
  const auth = new GoogleAuth({
    credentials: getServiceAccountCredentials(),
    scopes: SCOPES,
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();

  if (!token.token) {
    throw new Error("Failed to generate Google access token");
  }

  return token.token;
}

async function registerProject() {
  const accountId = requiredEnv("GOOGLE_MERCHANT_ACCOUNT_ID");
  const developerEmail = requiredEnv("GOOGLE_MERCHANT_DEVELOPER_EMAIL");
  const accessToken = await getAccessToken();

  const url =
    `https://merchantapi.googleapis.com/accounts/v1/` +
    `accounts/${accountId}/developerRegistration:registerGcp`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      developerEmail,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Status:", response.status);
    console.error(text);
    process.exit(1);
  }

  console.log("Google Cloud project registered successfully.");
  console.log(text || "Registration completed.");
}

registerProject().catch((error) => {
  console.error("Failed to register Google Cloud project:");
  console.error(error);
  process.exit(1);
});