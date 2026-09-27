import axios, { AxiosInstance } from 'axios';

export interface WgerWeightEntry {
  id: number;
  date: string; // YYYY-MM-DD
  weight: string; // decimal string
}

// wger 2.6 shapes: UUID ids, `datetime_start` on sessions, and
// `repetitions`/`repetitions_unit` on logs (decimal strings on the wire,
// parsed to numbers here).
export interface WgerWorkoutSession {
  id: string;
  routine: number | null;
  day: number | null;
  datetime_start: string;
  datetime_end: string | null;
  notes: string;
  impression: string;
}

export interface WgerWorkoutLog {
  id: string;
  exercise: number;
  session: string;
  repetitions: number | null;
  repetitions_unit: number; // 1 = Repetitions
  weight: string | null;
  weight_unit: number;
  date: string;
}

interface RawWorkoutSession extends Omit<WgerWorkoutSession, 'datetime_start'> {
  datetime_start: string | null;
}

interface RawWorkoutLog {
  id: string;
  exercise: number;
  session: string;
  repetitions: string | null;
  repetitions_unit: number;
  weight: string | null;
  weight_unit: number;
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
      // Cap each request so a hung upstream call cannot wedge a whole sync run.
      timeout: Number(process.env.REQUEST_TIMEOUT_MS ?? 30000),
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
    // In wger 2.6 the weight log is the "Body weight" measurement category, which
    // has NO uniqueness on date, so a blind POST creates a DUPLICATE every run.
    // Check-then-write: PATCH the existing entry for this date, else POST.
    const existing = await this.http.get<{ results: WgerWeightEntry[] }>(
      `/api/v2/weightentry/?format=json&date=${date}&limit=1`,
    );
    const entry = existing.data.results[0];
    if (entry) {
      if (Number(entry.weight) !== weight) {
        await this.http.patch(`/api/v2/weightentry/${entry.id}/`, { weight });
      }
      return;
    }
    await this.http.post('/api/v2/weightentry/', { date, weight });
  }

  async getMeasurementCategories(): Promise<WgerMeasurementCategory[]> {
    return this.paginate<WgerMeasurementCategory>('/api/v2/measurement-category/', '?format=json');
  }

  async createMeasurementCategory(name: string, unit: string): Promise<WgerMeasurementCategory> {
    // wger MeasurementCategory.unit is max_length 30; keep within bounds.
    const safeUnit = (unit ?? '').slice(0, 30);
    try {
      const res = await this.http.post<WgerMeasurementCategory>('/api/v2/measurement-category/', {
        name: name.slice(0, 100),
        unit: safeUnit,
      });
      return res.data;
    } catch (err: unknown) {
      // A category with this name may already exist (wger 400s on duplicate, and
      // our name|unit map can miss it when the unit differs). Reuse it by name.
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        const cats = await this.getMeasurementCategories();
        const existing = cats.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getMeasurements(since: Date, categoryId?: number): Promise<WgerMeasurement[]> {
    const sinceDate = since.toISOString().slice(0, 10);
    let qs = `?format=json&date__gte=${sinceDate}`;
    if (categoryId !== undefined) qs += `&category=${categoryId}`;
    return this.paginate<WgerMeasurement>('/api/v2/measurement/', qs);
  }

  async upsertMeasurement(categoryId: number | string, date: string, value: number): Promise<void> {
    // wger measurement.value is DecimalField(max_digits=8, decimal_places=2,
    // min 0). Round to 2 dp and reject genuinely out-of-range values.
    const v = Math.round(value * 100) / 100;
    if (!(v >= 0 && v <= 999999.99)) {
      throw new Error(`wger measurement value out of range (0..999999.99): ${value}`);
    }
    // The measurement endpoint has NO uniqueness on (category, date) for rows
    // without an external_id, so a blind POST creates a duplicate every run.
    // Check-then-write: PATCH the existing row for this category+date, else POST.
    const existing = await this.http.get<{ results: WgerMeasurement[] }>(
      `/api/v2/measurement/?format=json&category=${categoryId}&date=${date}&limit=1`,
    );
    const entry = existing.data.results[0];
    if (entry) {
      if (Number(entry.value) !== v) {
        await this.http.patch(`/api/v2/measurement/${entry.id}/`, { value: v });
      }
      return;
    }
    await this.http.post('/api/v2/measurement/', { category: categoryId, date, value: v });
  }

  async getWorkoutSessions(since: Date): Promise<WgerWorkoutSession[]> {
    // wger silently ignores unknown filters (e.g. the pre-2.6 `date__gte`),
    // which returns every session, so filter on the real field.
    const sinceDate = since.toISOString().slice(0, 10);
    const raw = await this.paginate<RawWorkoutSession>(
      '/api/v2/workoutsession/',
      `?format=json&ordering=datetime_start&datetime_start__gte=${sinceDate}`,
    );
    return raw.filter((s): s is WgerWorkoutSession => s.datetime_start !== null);
  }

  async getWorkoutLogs(sessionId: string): Promise<WgerWorkoutLog[]> {
    const raw = await this.paginate<RawWorkoutLog>(
      '/api/v2/workoutlog/',
      `?format=json&session=${encodeURIComponent(sessionId)}`,
    );
    return raw.map((l) => {
      const reps = l.repetitions === null ? null : Number(l.repetitions);
      return { ...l, repetitions: reps !== null && Number.isFinite(reps) ? reps : null };
    });
  }

  async getExerciseInfo(exerciseId: number): Promise<WgerExercise | null> {
    try {
      const res = await this.http.get<{
        translations: { name: string; language: number }[];
        category: { name: string };
      }>(`/api/v2/exerciseinfo/${exerciseId}/?format=json`); // names live on exerciseinfo in 2.6
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
