import axios, { AxiosInstance } from 'axios';

const TOKEN_TTL_MS = 9 * 60 * 1000; // refresh before 10-min expiry

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
  uuid: string;
  name: string;
}

interface TokenResponse {
  access: string;
  refresh: string;
}

interface TokenPair extends TokenResponse {
  expiresAt: number;
}

function sanitizeAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return `HTTP ${err.response?.status ?? 'unknown'} ${err.config?.url ?? ''}: ${JSON.stringify(err.response?.data ?? {})}`;
  }
  return String(err);
}

export class WgerClient {
  private http: AxiosInstance;
  private tokens: TokenPair | null = null;
  private weightUnit: number | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    this.http = axios.create({ baseURL: baseUrl });

    // Retry once on 401 by re-logging in
    const retried = new WeakSet<object>();
    this.http.interceptors.response.use(
      (res) => res,
      async (err) => {
        if (
          axios.isAxiosError(err) &&
          err.response?.status === 401 &&
          err.config &&
          !retried.has(err.config)
        ) {
          retried.add(err.config);
          await this.login();
          err.config.headers.set('Authorization', `Bearer ${this.tokens!.access}`);
          return this.http.request(err.config);
        }
        return Promise.reject(err);
      },
    );
  }

  private async ensureAuth(): Promise<void> {
    if (!this.tokens || Date.now() >= this.tokens.expiresAt) {
      await this.login();
    }
  }

  private async login(): Promise<void> {
    const res = await axios.post<TokenResponse>(`${this.baseUrl}/api/v2/token/`, {
      username: this.username,
      password: this.password,
    });
    const { access, refresh } = res.data;
    if (!access || !refresh) {
      throw new Error('wger auth response missing access or refresh token');
    }
    this.tokens = { access, refresh, expiresAt: Date.now() + TOKEN_TTL_MS };
    this.http.defaults.headers.common['Authorization'] = `Bearer ${access}`;
  }

  async getWeightUnit(): Promise<number> {
    if (this.weightUnit !== null) return this.weightUnit;
    await this.ensureAuth();
    const res = await this.http.get<{ weightunit: number }>('/api/v2/userprofile/');
    this.weightUnit = res.data.weightunit;
    return this.weightUnit;
  }

  async getWeightEntries(since: Date): Promise<WgerWeightEntry[]> {
    await this.ensureAuth();
    const sinceDate = since.toISOString().slice(0, 10);
    // date__gte for range filter; wger exact `date=` param only matches one day
    return this.paginate<WgerWeightEntry>('/api/v2/weightentry/', `?format=json&ordering=date&date__gte=${sinceDate}`);
  }

  async upsertWeightEntry(date: string, weight: number): Promise<void> {
    await this.ensureAuth();
    try {
      await this.http.post('/api/v2/weightentry/', { date, weight });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        const body = err.response.data as Record<string, unknown>;
        // Only treat as duplicate if the error mentions unique/existing constraint
        const bodyStr = JSON.stringify(body).toLowerCase();
        if (!bodyStr.includes('already') && !bodyStr.includes('unique') && !bodyStr.includes('exists')) {
          throw new Error(`wger weight POST 400 (not a duplicate): ${sanitizeAxiosError(err)}`);
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
    await this.ensureAuth();
    return this.paginate<WgerMeasurementCategory>('/api/v2/measurement-category/', '?format=json');
  }

  async createMeasurementCategory(name: string, unit: string): Promise<WgerMeasurementCategory> {
    await this.ensureAuth();
    const res = await this.http.post<WgerMeasurementCategory>('/api/v2/measurement-category/', {
      name,
      unit,
    });
    return res.data;
  }

  async getMeasurements(since: Date, categoryId?: number): Promise<WgerMeasurement[]> {
    await this.ensureAuth();
    const sinceDate = since.toISOString().slice(0, 10);
    let qs = `?format=json&date__gte=${sinceDate}`;
    if (categoryId !== undefined) qs += `&category=${categoryId}`;
    return this.paginate<WgerMeasurement>('/api/v2/measurement/', qs);
  }

  async upsertMeasurement(categoryId: number, date: string, value: number): Promise<void> {
    await this.ensureAuth();
    try {
      await this.http.post('/api/v2/measurement/', { category: categoryId, date, value });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        const bodyStr = JSON.stringify(err.response.data).toLowerCase();
        if (!bodyStr.includes('already') && !bodyStr.includes('unique') && !bodyStr.includes('exists')) {
          throw new Error(`wger measurement POST 400 (not a duplicate): ${sanitizeAxiosError(err)}`);
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
    await this.ensureAuth();
    const sinceDate = since.toISOString().slice(0, 10);
    return this.paginate<WgerWorkoutSession>(
      '/api/v2/workoutsession/',
      `?format=json&ordering=date&date__gte=${sinceDate}`,
    );
  }

  async getWorkoutLogs(sessionId: number): Promise<WgerWorkoutLog[]> {
    await this.ensureAuth();
    return this.paginate<WgerWorkoutLog>(
      '/api/v2/workoutlog/',
      `?format=json&workoutsession=${sessionId}`,
    );
  }

  async getExerciseInfo(exerciseId: number): Promise<WgerExercise | null> {
    await this.ensureAuth();
    try {
      const res = await this.http.get<{ translations: { name: string; language: number }[] }>(
        `/api/v2/exercise/${exerciseId}/?format=json`,
      );
      const translations = res.data.translations ?? [];
      const eng = translations.find((t) => t.language === 2) ?? translations[0];
      if (!eng) return null;
      return { id: exerciseId, uuid: '', name: eng.name };
    } catch {
      return null;
    }
  }

  private async paginate<T>(path: string, qs: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = `${path}${qs}`;
    while (url !== null) {
      await this.ensureAuth();
      type Page = { results: T[]; next: string | null };
      const res: Awaited<ReturnType<typeof this.http.get<Page>>> =
        await this.http.get<Page>(url);
      results.push(...res.data.results);
      const next = res.data.next;
      url = next ? next.replace(this.baseUrl, '') : null;
    }
    return results;
  }
}
