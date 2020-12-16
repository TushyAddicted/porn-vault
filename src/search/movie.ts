import Movie from "../types/movie";
import Studio from "../types/studio";
import { mapAsync } from "../utils/async";
import * as logger from "../utils/logger";
import {
  arrayFilter,
  bookmark,
  durationFilter,
  excludeFilter,
  favorite,
  getActorNames,
  getPage,
  getPageSize,
  includeFilter,
  ISearchResults,
  ratingFilter,
  shuffle,
  sort,
} from "./common";
import { getClient, indexMap } from "./index";
import { addSearchDocs, buildIndex, indexItems, ProgressCallback } from "./internal/buildIndex";

export interface IMovieSearchDoc {
  id: string;
  addedOn: number;
  name: string;
  actors: string[];
  labels: string[];
  actorNames: string[];
  labelNames: string[];
  rating: number;
  bookmark: number | null;
  favorite: boolean;
  releaseDate: number | null;
  releaseYear: number | null;
  duration: number | null;
  studios: string[];
  studioName: string | null;
  numScenes: number;
  custom: Record<string, boolean | string | number | string[] | null>;
  numActors: number;
}

export async function createMovieSearchDoc(movie: Movie): Promise<IMovieSearchDoc> {
  const labels = await Movie.getLabels(movie);
  const actors = await Movie.getActors(movie);
  const scenes = await Movie.getScenes(movie);

  const studio = movie.studio ? await Studio.getById(movie.studio) : null;
  const parentStudios = studio ? await Studio.getParents(studio) : [];

  return {
    id: movie._id,
    addedOn: movie.addedOn,
    name: movie.name,
    labels: labels.map((l) => l._id),
    actors: actors.map((a) => a._id),
    actorNames: actors.map(getActorNames).flat(),
    labelNames: labels.map((l) => [l.name]).flat(),
    studios: studio ? [studio, ...parentStudios].map((s) => s._id) : [],
    studioName: studio ? studio.name : null,
    rating: await Movie.getRating(movie),
    bookmark: movie.bookmark,
    favorite: movie.favorite,
    duration: await Movie.calculateDuration(movie),
    releaseDate: movie.releaseDate,
    releaseYear: movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : null,
    numScenes: scenes.length,
    custom: movie.customFields,
    numActors: actors.length,
  };
}

async function addMovieSearchDocs(docs: IMovieSearchDoc[]): Promise<void> {
  return addSearchDocs(indexMap.movies, docs);
}

export async function removeMovie(movieId: string): Promise<void> {
  await getClient().delete({
    index: indexMap.images,
    id: movieId,
    type: "_doc",
  });
}

export async function removeMovies(movieIds: string[]): Promise<void> {
  await mapAsync(movieIds, removeMovie);
}

export async function indexMovies(movies: Movie[], progressCb?: ProgressCallback): Promise<number> {
  return indexItems(movies, createMovieSearchDoc, addMovieSearchDocs, progressCb);
}

export async function buildMovieIndex(): Promise<void> {
  await buildIndex(indexMap.movies, Movie.getAll, indexMovies);
}

export interface IMovieSearchQuery {
  query: string;
  favorite?: boolean;
  bookmark?: boolean;
  rating: number;
  include?: string[];
  exclude?: string[];
  studios?: string[];
  actors?: string[];
  sortBy?: string;
  sortDir?: string;
  skip?: number;
  take?: number;
  page?: number;
  durationMin?: number;
  durationMax?: number;
}

export async function searchMovies(
  options: Partial<IMovieSearchQuery>,
  shuffleSeed = "default",
  extraFilter: unknown[] = []
): Promise<ISearchResults> {
  logger.log(`Searching movies for '${options.query || "<no query>"}'...`);

  const query = () => {
    if (options.query && options.query.length) {
      return [
        {
          multi_match: {
            query: options.query || "",
            fields: ["name", "actorNames^1.5", "labelNames", "studioName"],
            fuzziness: "AUTO",
          },
        },
      ];
    }
    return [];
  };

  const result = await getClient().search<IMovieSearchDoc>({
    index: indexMap.movies,
    ...getPage(options.page, options.skip, options.take),
    body: {
      ...sort(options.sortBy, options.sortDir, options.query),
      track_total_hits: true,
      query: {
        bool: {
          must: shuffle(shuffleSeed, options.sortBy, query().filter(Boolean)),
          filter: [
            ratingFilter(options.rating),
            ...bookmark(options.bookmark),
            ...favorite(options.favorite),

            ...includeFilter(options.include),
            ...excludeFilter(options.exclude),

            ...arrayFilter(options.actors, "actors", "AND"),
            ...arrayFilter(options.studios, "studios", "OR"),

            durationFilter(options.durationMin, options.durationMax),

            ...extraFilter,
          ],
        },
      },
    },
  });
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const total: number = result.hits.total.value;

  return {
    items: result.hits.hits.map((doc) => doc._source.id),
    total,
    numPages: Math.ceil(total / getPageSize(options.take)),
  };
}
