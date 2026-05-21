import axios, { AxiosInstance } from 'axios';

export interface WgerWeightEntry {
  id: number;
  date: string; // YYYY-MM-DD
  weight: string; // decimal string
}

export interface WgerWorkoutSession {
  id: number;
  workout: number;
  date: string;
  notes: string;
  impression: string;
  time_start: string | null;
  time_end: string | null;
}

export interface WgerWorkoutLog {
  id: number;
  exercise: number;
  workout: number;
  workoutsession: number;
  reps: number | null;
  weight: string | null;
  weight_unit: number;
  repetition_unit: number;
  date: string;
}

export interface WgerMeasurementCategory {
  id: number;
  name: string;
  unit: string;
}

export interface WgerMeasurement {
  id: number;
  category: number;
  date: string;
  value: string;
  notes: string;
}

export interface WgerExercise {
  id: number;
  name: string;
  category: string;
}

function sanitizeAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return `HTTP ${err.response?.status ?? '?'} ${err.config?.url ?? ''}: ${JSON.stringify(err.response?.data ?? {})}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export class WgerClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, apiToken: string) {
    // wger uses "Token <key>" (DRF token auth) — no JWT refresh needed
    this.http = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Token ${apiToken}` },
    });
  }

  async getWeightEntries(since: Date): Promise<WgerWeightEntry[]> {
    const sinceDate = since.toISOString().slice(0, 10);
    return this.paginate<WgerWeightEntry>(
      '/api/v2/weightentry/',
      `?format=json&ordering=date&date__gte=${sinceDate}`,
    );
  }

  async upsertWeightEntry(date: string, weight: number): Promise<void> {
    try {
      await this.http.post('/api/v2/weightentry/', { date, weight });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        const bodyStr = JSON.stringify(err.response.data).toLowerCase();
        if (!bodyStr.includes('already') && !bodyStr.includes('unique') && !bodyStr.includes('exists')) {
          throw new Error(`wger weight POST 400 (not duplicate): ${sanitizeAxiosError(err)}`);
        }
        const existing = await this.http.get<{ results: WgerWeightEntry[] }>(
          `/api/v2/weightentry/?format=json&date=${date}`,
        );
        const entry = existing.data.results[0];
        if (entry) {
          await this.http.patch(`/api/v2/weightentry/${entry.id}/`, { weight });
        }
      } else {
        throw err;
      }
    }
  }

  async getMeasurementCategories(): Promise<WgerMeasurementCategory[]> {
    return this.paginate<WgerMeasurementCategory>('/api/v2/measurement-category/', '?format=json');
  }

  async createMeasurementCategory(name: string, unit: string): Promise<WgerMeasurementCategory> {
    const res = await this.http.post<WgerMeasurementCategory>('/api/v2/measurement-category/', {
      name,
      unit,
    });
    return res.data;
  }

  async getMeasurements(since: Date, categoryId?: number): Promise<WgerMeasurement[]> {
    const sinceDate = since.toISOString().slice(0, 10);
    let qs = `?format=json&date__gte=${sinceDate}`;
    if (categoryId !== undefined) qs += `&category=${categoryId}`;
    return this.paginate<WgerMeasurement>('/api/v2/measurement/', qs);
  }

  async upsertMeasurement(categoryId: number, date: string, value: number): Promise<void> {
    try {
      await this.http.post('/api/v2/measurement/', { category: categoryId, date, value });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        const bodyStr = JSON.stringify(err.response.data).toLowerCase();
        if (!bodyStr.includes('already') && !bodyStr.includes('unique') && !bodyStr.includes('exists')) {
          throw new Error(`wger measurement POST 400 (not duplicate): ${sanitizeAxiosError(err)}`);
        }
        const existing = await this.http.get<{ results: WgerMeasurement[] }>(
          `/api/v2/measurement/?format=json&category=${categoryId}`,
        );
        const entry = existing.data.results.find((m) => m.date === date);
        if (entry) {
          await this.http.patch(`/api/v2/measurement/${entry.id}/`, { value });
        }
      } else {
        throw err;
      }
    }
  }

  async getWorkoutSessions(since: Date): Promise<WgerWorkoutSession[]> {
    const sinceDate = since.toISOString().slice(0, 10);
    return this.paginate<WgerWorkoutSession>(
      '/api/v2/workoutsession/',
      `?format=json&ordering=date&date__gte=${sinceDate}`,
    );
  }

  async getWorkoutLogs(sessionId: number): Promise<WgerWorkoutLog[]> {
    return this.paginate<WgerWorkoutLog>(
      '/api/v2/workoutlog/',
      `?format=json&workoutsession=${sessionId}`,
    );
  }

  async getExerciseInfo(exerciseId: number): Promise<WgerExercise | null> {
    try {
      const res = await this.http.get<{
        translations: { name: string; language: number }[];
        category: { name: string };
      }>(`/api/v2/exercise/${exerciseId}/?format=json`);
      const translations = res.data.translations ?? [];
      const eng = translations.find((t) => t.language === 2) ?? translations[0];
      if (!eng) return null;
      return {
        id: exerciseId,
        name: eng.name,
        category: res.data.category?.name ?? 'Strength',
      };
    } catch {
      return null;
    }
  }

  private async paginate<T>(path: string, qs: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = `${path}${qs}`;
    while (url !== null) {
      type Page = { results: T[]; next: string | null };
      const res: Awaited<ReturnType<typeof this.http.get<Page>>> =
        await this.http.get<Page>(url);
      results.push(...res.data.results);
      const next = res.data.next;
      url = next ? next.replace(this.http.defaults.baseURL ?? '', '') : null;
    }
    return results;
  }
}
