import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({ imports: [PlansModule], controllers: [OnboardingController], providers: [OnboardingService], exports: [OnboardingService] })
export class OnboardingModule {}
