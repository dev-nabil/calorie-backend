import { Module } from '@nestjs/common';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';

/** Saved recipes (Milo buddy): /recipes; chat saves through RecipesService. */
@Module({ controllers: [RecipesController], providers: [RecipesService], exports: [RecipesService] })
export class RecipesModule {}
