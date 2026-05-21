import axios, { AxiosInstance } from 'axios';

export interface SparkyCheckIn {
  id?: number;
  date: string; // YYYY-MM-DD
  weight?: number;
  neck?: number;
  waist?: number;
  hips?: number;
  steps?: number;
  height?: number;
  body_fat_percentage?: number;
}

export interface SparkyCustomCategory {
  id?: string; // UUID
  name: string;
  unit: string;
}

export interface SparkyCustomEntry {
  id?: string;
  category_id: string; // UUID
  date: string; // YYYY-MM-DD
  value: number;
}

export interface SparkyExercise {
  id: string; // UUID
  name: string;
  category?: string;
}

export interface SparkySet {
  reps?: number;
  weight?: number;
  duration?: number;
}

export interface SparkyExerciseEntryCreate {
  exercise_id: string; // UUID
  entry_date: string; // YYYY-MM-DD
  sets?: SparkySet[];
  reps?: number;
  weight?: number;
  duration_minutes?: number;
  notes?: string;
}

function sanitize(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return `HTTP ${err.response?.status ?? '?'} ${err.config?.url ?? ''}: ${JSON.stringify(err.response?.data ?? {})}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export class SparkyClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        // API key ≥64 chars with no dots is auto-detected as API key by Sparky's auth middleware
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  // Weight check-ins -------------------------------------------------------

  async getCheckInsRange(startDate: string, endDate: string): Promise<SparkyCheckIn[]> {
    const res = await this.http.get<SparkyCheckIn[]>(
      `/measurements/check-in-measurements-range/${startDate}/${endDate}`,
    );
    return res.data;
  }

  async upsertCheckIn(entry: SparkyCheckIn): Promise<void> {
    await this.http.post('/measurements/check-in', entry);
  }

  // Custom measurement categories ------------------------------------------

  async getCustomCategories(): Promise<SparkyCustomCategory[]> {
    const res = await this.http.get<SparkyCustomCategory[]>('/measurements/custom-categories');
    return res.data;
  }

  async createCustomCategory(
    category: Omit<SparkyCustomCategory, 'id'>,
  ): Promise<SparkyCustomCategory> {
    const res = await this.http.post<SparkyCustomCategory>('/measurements/custom-categories', category);
    return res.data;
  }

  // Custom measurement entries ---------------------------------------------

  async getCustomEntriesRange(
    categoryId: string,
    startDate: string,
    endDate: string,
  ): Promise<SparkyCustomEntry[]> {
    const res = await this.http.get<SparkyCustomEntry[]>(
      `/measurements/custom-measurements-range/${categoryId}/${startDate}/${endDate}`,
    );
    return res.data;
  }

  async upsertCustomEntry(entry: SparkyCustomEntry): Promise<void> {
    await this.http.post('/measurements/custom-entries', entry);
  }

  // Exercises --------------------------------------------------------------

  async searchExercise(name: string): Promise<SparkyExercise | null> {
    const res = await this.http.get<SparkyExercise[]>('/exercises/search', {
      params: { searchTerm: name },
    });
    const results = res.data;
    if (!results.length) return null;
    // Prefer exact name match (case-insensitive)
    const exact = results.find((e) => e.name.toLowerCase() === name.toLowerCase());
    return exact ?? results[0];
  }

  async createExercise(name: string, category: string): Promise<SparkyExercise> {
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append(
      'exerciseData',
      JSON.stringify({
        name,
        category,
        equipment: [],
        muscle_groups: [],
        description: '',
        instructions: [],
        is_public: false,
      }),
    );
    const res = await this.http.post<SparkyExercise>('/exercises', form, {
      headers: form.getHeaders(),
    });
    return res.data;
  }

  // Exercise entries -------------------------------------------------------

  async createExerciseEntry(entry: SparkyExerciseEntryCreate): Promise<void> {
    await this.http.post('/exercise-entries', entry);
  }
}

export { sanitize as sanitizeSparkyError };
