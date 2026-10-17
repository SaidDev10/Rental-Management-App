import { GetParameterCommand } from '@aws-sdk/client-ssm';

import { getSsmClient } from '../aws/clients';

const secretCache = new Map<string, Promise<string>>();

export const getSecret = async (parameterName: string): Promise<string> => {
  let secretPromise = secretCache.get(parameterName);

  if (!secretPromise) {
    secretPromise = getSsmClient()
      .send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))
      .then((result) => {
        const value = result.Parameter?.Value;

        if (!value) {
          throw new Error(`Required secret "${parameterName}" has no value.`);
        }

        return value;
      });
    secretCache.set(parameterName, secretPromise);
  }

  try {
    return await secretPromise;
  } catch (error) {
    secretCache.delete(parameterName);

    throw error;
  }
};
