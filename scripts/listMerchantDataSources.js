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
  const credentials = JSON.parse(json);

  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }

  return credentials;
}

async function getAccessToken() {
  const auth = new GoogleAuth({
    credentials: getServiceAccountCredentials(),
    scopes: SCOPES,
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();

  const accessToken =
    typeof tokenResponse === "string"
      ? tokenResponse
      : tokenResponse.token;

  if (!accessToken) {
    throw new Error("Failed to generate Google access token");
  }

  return accessToken;
}

async function listDataSources() {
  const accountId = requiredEnv("GOOGLE_MERCHANT_ACCOUNT_ID");
  const accessToken = await getAccessToken();

  const url =
    `https://merchantapi.googleapis.com/datasources/v1/` +
    `accounts/${accountId}/dataSources`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Failed to list Merchant Center data sources.");
    console.error("Status:", response.status);
    console.error(text);
    process.exit(1);
  }

  if (!text) {
    console.log("No response body returned.");
    return;
  }

  const data = JSON.parse(text);

  console.log("Merchant Center data sources:");
  console.log(JSON.stringify(data, null, 2));
}

listDataSources().catch((error) => {
  console.error("Failed to list Merchant Center data sources:");
  console.error(error);
  process.exit(1);
});