import axios, { AxiosInstance } from 'axios';

export interface SparkyWeightCheckIn {
  id?: number;
  check_in_date: string; // YYYY-MM-DD
  weight: number;
  notes?: string;
}

export interface SparkyCustomCategory {
  id?: number;
  name: string;
  unit: string;
}

export interface SparkyCustomMeasurement {
  id?: number;
  measurement_date: string; // YYYY-MM-DD
  category_id: number;
  value: number;
  notes?: string;
}

// POST /exercise-entries body.
// NOTE: Confirm exact field names against live API on first deploy.
// Service uses findExerciseByNameAndUserId then creates if missing.
export interface SparkyExerciseEntryCreate {
  entry_date: string; // YYYY-MM-DD
  exercise_name: string;
  sets?: number;
  reps?: number;
  weight?: number;
  weight_unit?: string; // 'kg' | 'lb'
  duration_minutes?: number;
  notes?: string;
}

export class SparkyClient {
  private http: AxiosInstance;

  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly userId: string,
  ) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-User-Id': userId,
      },
    });
  }

  async getWeightCheckIns(since: Date): Promise<SparkyWeightCheckIn[]> {
    const res = await this.http.get<SparkyWeightCheckIn[]>('/api/measurements/check-in', {
      params: { start_date: since.toISOString().slice(0, 10), user_id: this.userId },
    });
    return res.data;
  }

  async createWeightCheckIn(entry: SparkyWeightCheckIn): Promise<void> {
    await this.http.post('/api/measurements/check-in', { ...entry, user_id: this.userId });
  }

  async getCustomCategories(): Promise<SparkyCustomCategory[]> {
    const res = await this.http.get<SparkyCustomCategory[]>('/measurements/custom-categories', {
      params: { user_id: this.userId },
    });
    return res.data;
  }

  async createCustomCategory(category: Omit<SparkyCustomCategory, 'id'>): Promise<SparkyCustomCategory> {
    const res = await this.http.post<SparkyCustomCategory>('/measurements/custom-categories', {
      ...category,
      user_id: this.userId,
    });
    return res.data;
  }

  async getCustomMeasurements(since: Date): Promise<SparkyCustomMeasurement[]> {
    const res = await this.http.get<SparkyCustomMeasurement[]>('/measurements/custom', {
      params: { start_date: since.toISOString().slice(0, 10), user_id: this.userId },
    });
    return res.data;
  }

  async createCustomMeasurement(entry: SparkyCustomMeasurement): Promise<void> {
    await this.http.post('/measurements/custom', { ...entry, user_id: this.userId });
  }

  async createExerciseEntry(entry: SparkyExerciseEntryCreate): Promise<void> {
    await this.http.post('/exercise-entries', { ...entry, user_id: this.userId });
  }
}
