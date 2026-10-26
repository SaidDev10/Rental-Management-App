export type PropertyType = 'apartment' | 'house' | 'studio' | 'commercial' | 'other';

export type PropertyAddress = {
  line1: string;
  line2?: string | undefined;
  city: string;
  postalCode?: string | undefined;
  country: 'MA';
};

export type Property = {
  id: string;
  accountId: string;
  label: string;
  address: PropertyAddress;
  propertyType: PropertyType;
  areaSqm: number | null;
  rooms: number | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  notes: string | null;
  photoKeys: string[];
  status: 'active' | 'inactive';
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PropertyDetail = Property & {
  activeLeaseId: string | null;
};

export type CreatePropertyInput = Omit<
  Property,
  'id' | 'accountId' | 'photoKeys' | 'version' | 'createdAt' | 'updatedAt'
>;

export type UpdatePropertyInput = {
  [Key in keyof CreatePropertyInput]?: CreatePropertyInput[Key] | undefined;
};

export const PROPERTY_PHOTO_LIMIT = 20;
