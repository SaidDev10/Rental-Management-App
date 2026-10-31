import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let dynamoClient: DynamoDBClient | undefined;
let dynamoDocumentClient: DynamoDBDocumentClient | undefined;
let cloudWatchClient: CloudWatchClient | undefined;
let s3Client: S3Client | undefined;
let sqsClient: SQSClient | undefined;
let sesClient: SESv2Client | undefined;
let ssmClient: SSMClient | undefined;

const region = (): string => process.env.AWS_REGION ?? 'eu-west-1';

export const getDynamoClient = (): DynamoDBClient => {
  dynamoClient ??= new DynamoDBClient({ region: region() });

  return dynamoClient;
};

export const getDynamoDocumentClient = (): DynamoDBDocumentClient => {
  dynamoDocumentClient ??= DynamoDBDocumentClient.from(getDynamoClient(), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return dynamoDocumentClient;
};

export const getCloudWatchClient = (): CloudWatchClient => {
  cloudWatchClient ??= new CloudWatchClient({ region: region() });

  return cloudWatchClient;
};

export const getS3Client = (): S3Client => {
  s3Client ??= new S3Client({ region: region() });

  return s3Client;
};

export const getSqsClient = (): SQSClient => {
  sqsClient ??= new SQSClient({ region: region() });

  return sqsClient;
};

export const getSesClient = (): SESv2Client => {
  sesClient ??= new SESv2Client({ region: region() });

  return sesClient;
};

export const getSsmClient = (): SSMClient => {
  ssmClient ??= new SSMClient({ region: region() });

  return ssmClient;
};
