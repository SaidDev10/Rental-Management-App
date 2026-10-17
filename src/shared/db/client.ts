import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDynamoDocumentClient } from '../aws/clients';

export const createDocumentClient = (): DynamoDBDocumentClient => {
  const lowLevelClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'eu-west-1',
  });

  return DynamoDBDocumentClient.from(lowLevelClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
};

export const getDocumentClient = (): DynamoDBDocumentClient => {
  return getDynamoDocumentClient();
};
