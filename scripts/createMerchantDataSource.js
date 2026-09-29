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
  const token = await client.getAccessToken();

  if (!token.token) {
    throw new Error("Failed to generate Google access token");
  }

  return token.token;
}

async function createDataSource() {
  const accountId = requiredEnv("GOOGLE_MERCHANT_ACCOUNT_ID");
  const accessToken = await getAccessToken();

  const url =
    `https://merchantapi.googleapis.com/datasources/v1/` +
    `accounts/${accountId}/dataSources`;

  const body = {
    displayName: "Presentail OS API Products",
    primaryProductDataSource: {
      countries: ["LB", "AE"],
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Status:", response.status);
    console.error(text);
    process.exit(1);
  }

  const data = JSON.parse(text);

  console.log("Data source created successfully.");
  console.log("");
  console.log("Copy this value into Replit Secrets:");
  console.log("");
  console.log(`GOOGLE_MERCHANT_DATA_SOURCE_NAME=${data.name}`);
  console.log("");
  console.log("Full response:");
  console.log(JSON.stringify(data, null, 2));
}

createDataSource().catch((error) => {
  console.error("Failed to create Merchant Center data source:");
  console.error(error);
  process.exit(1);
});